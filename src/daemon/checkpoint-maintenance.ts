import { copyFile, link, lstat, mkdir, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { checkpointDirectory } from "./checkpoints.js";
import { initialize, readCommitTree, readHead, readTree, verifyBlob, writeCommit, writeHead, TREE_MODE } from "./checkpoint-objects.js";
import type { AgentCheckpointTurn } from "./agent-checkpoints.js";

export const CHECKPOINT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const CHECKPOINT_MAX_TURNS = 20;
const FREE_SPACE_RESERVE = 64 * 1024 * 1024;
const ROOT_EXCLUDED = new Set(["dist", "build", "out", ".ohmygame", ".ohmygame-install-pending"]);
const ANYWHERE_EXCLUDED = new Set(["node_modules", ".git"]);

export interface CheckpointLedger {
  version: 1;
  turns: AgentCheckpointTurn[];
  recoveries: Array<{ commit: string; createdAt: string }>;
}

function rotationPaths(project: Pick<ProjectState, "workspacePath" | "storagePath">) {
  const active = checkpointDirectory(project);
  return { active, next: active + ".next", previous: active + ".previous" };
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return false;
    throw cause;
  });
}

/**
 * An interrupted rotation is recoverable: until the replacement is installed,
 * the original store (and its complete history) remains in .previous.
 */
export async function recoverCheckpointRotation(project: Pick<ProjectState, "workspacePath" | "storagePath">): Promise<void> {
  const { active, next, previous } = rotationPaths(project);
  if (!(await exists(active)) && await exists(previous)) await rename(previous, active);
  if (await exists(active)) {
    if (await exists(next)) await rm(next, { recursive: true, force: true });
    if (await exists(previous)) await rm(previous, { recursive: true, force: true });
  } else if (await exists(next)) {
    // A first-time compaction that never reached rotation left no live store.
    await rm(next, { recursive: true, force: true });
  }
}

async function bytesUsed(directory: string): Promise<number> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
  let total = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await bytesUsed(file);
    else total += (await lstat(file)).size;
  }
  return total;
}

/** A conservative bound for what one entirely new snapshot could write. */
async function workspaceBytes(root: string, relative = ""): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = entry.name;
    const nested = relative ? `${relative}/${name}` : name;
    if (ANYWHERE_EXCLUDED.has(name.toLowerCase())
      || (!relative && ROOT_EXCLUDED.has(name))
      || nested === ".data/agent-attachments"
      || (name.startsWith(".ohmygame-checkpoint-") && name.endsWith(".tmp"))) continue;
    if (entry.isDirectory()) total += await workspaceBytes(root, nested);
    else if (entry.isFile() || entry.isSymbolicLink()) total += (await lstat(path.join(root, nested))).size;
  }
  return total;
}

/**
 * Fail closed before allowing another mutating Agent turn if a snapshot cannot
 * fit. Existing snapshots and game files are never deleted as a quota fallback.
 */
export async function assertCheckpointCapacity(
  project: Pick<ProjectState, "workspacePath" | "storagePath">,
  maxBytes = CHECKPOINT_MAX_BYTES,
): Promise<void> {
  const bytes = await workspaceBytes(project.workspacePath);
  const used = await bytesUsed(checkpointDirectory(project));
  // Allow a small margin for tree/commit metadata and compressed-file overhead.
  if (used + bytes + Math.min(1024 * 1024, Math.floor(maxBytes * 0.01)) > maxBytes) {
    throw new Error(`Checkpoint limit reached (${Math.round(maxBytes / (1024 * 1024))} MiB per project). Clear old checkpoints through the application's recovery history, or free local disk space; game files were not touched.`);
  }
  const storage = project.storagePath ?? path.dirname(project.workspacePath);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const disk = await statfs(storage);
  if (Number(disk.bavail) * Number(disk.bsize) < bytes + FREE_SPACE_RESERVE) {
    throw new Error("Not enough free local disk space for a safe game checkpoint. Free disk space before asking the Agent to change files.");
  }
}

/** Copy only the trees and validated blobs needed by retained snapshots. */
async function copyTreeObjects(source: string, target: string, tree: string, copied: Set<string>): Promise<void> {
  if (copied.has(tree)) return;
  const entries = await readTree(source, tree);
  for (const entry of entries) {
    if (entry.mode === TREE_MODE) await copyTreeObjects(source, target, entry.oid, copied);
    else if (!copied.has(entry.oid)) {
      await verifyBlob(source, entry.oid);
      await copyObject(source, target, entry.oid);
      copied.add(entry.oid);
    }
  }
  await copyObject(source, target, tree);
  copied.add(tree);
}

async function copyObject(source: string, target: string, oid: string): Promise<void> {
  const relative = path.join("objects", oid.slice(0, 2), oid.slice(2));
  const destination = path.join(target, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  try { await link(path.join(source, relative), destination); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV"
      && (cause as NodeJS.ErrnoException).code !== "EPERM"
      && (cause as NodeJS.ErrnoException).code !== "ENOTSUP") throw cause;
    await copyFile(path.join(source, relative), destination);
  }
}

/**
 * Compact a completed project history without modifying its workspace.
 * Build and verify a new store alongside the old one before rotating paths.
 * Older restore IDs are no longer offered; keep the most recent recovery ID.
 */
export async function compactCheckpointHistory(
  project: Pick<ProjectState, "workspacePath" | "storagePath">,
  ledger: CheckpointLedger,
  keepTurns = CHECKPOINT_MAX_TURNS,
): Promise<CheckpointLedger> {
  await recoverCheckpointRotation(project);
  const { active, next, previous } = rotationPaths(project);
  const keptTurns = ledger.turns.slice(-Math.max(1, keepTurns));
  const keptRecoveries = ledger.recoveries.slice(-1);
  const head = await readHead(active);
  const ids = [...new Set([
    ...keptTurns.flatMap((entry) => [entry.before, ...(entry.after ? [entry.after] : [])]),
    ...keptRecoveries.map((entry) => entry.commit),
    ...(head ? [head] : []),
  ])];
  if (!ids.length) return ledger;
  await mkdir(next, { mode: 0o700 });
  const remapped = new Map<string, string>();
  const copied = new Set<string>();
  let parent: string | undefined;
  try {
    await initialize(next);
    for (const id of ids) {
      const tree = await readCommitTree(active, id);
      await copyTreeObjects(active, next, tree, copied);
      const nextCommit = await writeCommit(next, tree, parent);
      remapped.set(id, nextCommit);
      parent = nextCommit;
    }
    if (parent) await writeHead(next, parent);
    const mapId = (id: string) => {
      const replacement = remapped.get(id);
      if (!replacement) throw new Error("Checkpoint history could not be preserved");
      return replacement;
    };
    const updated: CheckpointLedger = {
      version: 1,
      turns: keptTurns.map((entry) => ({ ...entry, before: mapId(entry.before), ...(entry.after ? { after: mapId(entry.after) } : {}) })),
      recoveries: keptRecoveries.map((entry) => ({ ...entry, commit: mapId(entry.commit) })),
    };
    await writeFile(path.join(next, "agent-turns.json"), JSON.stringify(updated, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(active, previous);
    try { await rename(next, active); }
    catch (cause) { await rename(previous, active); throw cause; }
    // A crash before cleanup leaves .previous, cleaned at the next operation.
    await rm(previous, { recursive: true, force: true }).catch(() => {});
    return updated;
  } catch (cause) {
    if (await exists(next)) await rm(next, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}

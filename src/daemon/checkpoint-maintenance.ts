import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { checkpointDirectory } from "./checkpoints.js";
import { initialize, readCommit, readCommitTree, readHead, readTree, verifyBlob, writeAtomically, writeCommit, writeHead, TREE_MODE } from "./checkpoint-objects.js";
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
  if (await exists(active) && await exists(previous)) {
    // Retain the last known-good archive if the replacement is incomplete.
    if (!(await rotatedStoreUsable(active))) {
      throw new Error("Incomplete checkpoint rotation: previous recovery store was preserved");
    }
  }
  if (await exists(active)) {
    if (await exists(next)) await rm(next, { recursive: true, force: true });
    if (await exists(previous)) await rm(previous, { recursive: true, force: true });
  } else if (await exists(next)) {
    // A first-time compaction that never reached rotation left no live store.
    await rm(next, { recursive: true, force: true });
  }
}

/** Validate the replacement before deleting the last known-good backup. */
async function rotatedStoreUsable(directory: string): Promise<boolean> {
  try {
    const head = await readHead(directory);
    if (!head) return false;
    const checkedTrees = new Set<string>();
    const checkedBlobs = new Set<string>();
    const verifyTree = async (tree: string): Promise<void> => {
      if (checkedTrees.has(tree)) return;
      const entries = await readTree(directory, tree);
      checkedTrees.add(tree);
      for (const entry of entries) {
        if (!/^[a-f0-9]{40}$/.test(entry.oid) || !entry.name || entry.name === "." || entry.name === ".."
          || entry.name.includes("/") || entry.name.includes("\\") || !["40000", "100644", "100755", "120000"].includes(entry.mode)) {
          throw new Error("Invalid checkpoint tree entry");
        }
        if (entry.mode === TREE_MODE) await verifyTree(entry.oid);
        else if (!checkedBlobs.has(entry.oid)) {
          await verifyBlob(directory, entry.oid);
          checkedBlobs.add(entry.oid);
        }
      }
    };
    await verifyTree(await readCommitTree(directory, head));
    const raw: unknown = JSON.parse(await readFile(path.join(directory, "agent-turns.json"), "utf8"));
    if (!raw || typeof raw !== "object") return false;
    const ledger = raw as Partial<CheckpointLedger>;
    if (ledger.version !== 1 || !Array.isArray(ledger.turns) || !Array.isArray(ledger.recoveries)) return false;
    const commitIds = [
      ...ledger.turns.flatMap((turn) => [turn.before, ...(turn.after ? [turn.after] : [])]),
      ...ledger.recoveries.map((recovery) => recovery.commit),
    ];
    for (const id of commitIds) {
      if (!/^[a-f0-9]{40}$/.test(id)) return false;
      await verifyTree(await readCommitTree(directory, id));
    }
    return true;
  } catch {
    return false;
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
    throw new Error(`Checkpoint limit reached (${Math.round(maxBytes / (1024 * 1024))} MiB per project). Keep the project within its checkpoint budget or free local disk space before another Agent run; game files and existing recovery points were not touched.`);
  }
  const storage = project.storagePath ?? path.dirname(project.workspacePath);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const disk = await statfs(storage);
  if (Number(disk.bavail) * Number(disk.bsize) < bytes + FREE_SPACE_RESERVE) {
    throw new Error("Not enough free local disk space for a safe game checkpoint. Free disk space before asking the Agent to change files.");
  }
}

/** Pi session checkpoints pin Git object IDs independently of the legacy ledger.
 * Once a persisted conversation exists, rotating only the legacy store could
 * permanently orphan the modern Undo/Reapply history. Keep all objects until
 * both indexes can be compacted together; the per-project size limit still
 * rejects new Agent turns before writing when there is insufficient capacity.
 */
export async function hasPersistentConversations(project: Pick<ProjectState, "workspacePath" | "storagePath">): Promise<boolean> {
  const directory = path.join(project.storagePath ?? path.dirname(project.workspacePath), "session");
  try {
    return (await readdir(directory)).some((name) => name.endsWith(".jsonl"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
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
  if (await hasPersistentConversations(project)) {
    // Only prune legacy navigation metadata; never rewrite Pi checkpoint IDs.
    const updated: CheckpointLedger = { version: 1, turns: keptTurns, recoveries: keptRecoveries };
    await writeAtomically(active, path.join(active, "agent-turns.json"), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  }
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
      const { tree, unreadable } = await readCommit(active, id);
      await copyTreeObjects(active, next, tree, copied);
      // Retain the unreadable-file scope. Losing this metadata could make an
      // omitted private file look like a deletion during a future restore.
      const nextCommit = await writeCommit(next, tree, parent, unreadable);
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
    // Verify not just commit/tree metadata, but every reachable image/code blob
    // before the old store can be displaced or discarded.
    if (!(await rotatedStoreUsable(next))) throw new Error("Checkpoint rotation failed verification; existing snapshots were preserved");
    await rename(active, previous);
    try { await rename(next, active); }
    catch (cause) { await rename(previous, active); throw cause; }
    // A crash or disk fault during rotation must not delete the sole known-good
    // archive. Keep .previous until the installed replacement verifies too.
    if (!(await rotatedStoreUsable(active))) throw new Error("Incomplete checkpoint rotation: previous recovery store was preserved");
    await rm(previous, { recursive: true, force: true }).catch(() => {});
    return updated;
  } catch (cause) {
    if (await exists(next)) await rm(next, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { CheckpointStore, checkpointDirectory, type CheckpointChange, type CheckpointRestoreResult, type CheckpointUndoResult } from "./checkpoints.js";
import { assertCheckpointCapacity, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_TURNS, compactCheckpointHistory, recoverCheckpointRotation, type CheckpointLedger } from "./checkpoint-maintenance.js";

const COMMIT_ID = /^[a-f0-9]{40}$/;

export interface AgentCheckpointTurn {
  turnId: string;
  conversationId: string;
  before: string;
  after?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Project-private manifest; snapshots themselves are kept in CheckpointStore's Git objects. */
export class AgentCheckpoints {
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store = new CheckpointStore(),
    private readonly maxBytes = CHECKPOINT_MAX_BYTES,
  ) {}

  async before(project: ProjectState, conversationId: string, turnId: string): Promise<void> {
    await this.#serialize(project, async () => {
      const unfinished = await this.store.unfinished(project);
      if (unfinished) throw new Error("A previous checkpoint restore was interrupted; recover it before running the Agent");
      let ledger = await this.#read(project);
      if (ledger.turns.some((entry) => entry.turnId === turnId)) throw new Error("An Agent checkpoint already exists for this turn");
      ledger = await this.#prepare(project, ledger);
      // Do not permit the Agent to mutate files if creating a durable snapshot fails.
      const before = await this.store.snapshot(project);
      ledger.turns.push({ turnId, conversationId, before, startedAt: new Date().toISOString() });
      await this.#write(project, ledger);
    });
  }

  async after(project: ProjectState, turnId: string): Promise<void> {
    await this.#serialize(project, async () => {
      const ledger = await this.#read(project);
      const entry = ledger.turns.find((turn) => turn.turnId === turnId);
      if (!entry || entry.after) return; // A failed setup never needs an undo range.
      // If assets became too large during this turn, preserve the "before" snapshot
      // and reject the next run instead of growing the private history unchecked.
      await assertCheckpointCapacity(project, this.maxBytes);
      const after = await this.store.snapshot(project);
      entry.after = after;
      entry.finishedAt = new Date().toISOString();
      await this.#write(project, ledger);
      if (ledger.turns.length > CHECKPOINT_MAX_TURNS) await compactCheckpointHistory(project, ledger);
    });
  }

  async list(project: ProjectState): Promise<{ turns: Array<AgentCheckpointTurn & { changes?: CheckpointChange[] }>; recoveries: string[]; unfinished?: string }> {
    return this.#serialize(project, async () => {
      const ledger = await this.#read(project);
      const unfinished = await this.store.unfinished(project);
      const turns = await Promise.all([...ledger.turns].reverse().map(async (turn) => ({
        ...turn,
        ...(turn.after ? { changes: await this.store.diff(project, turn.before, turn.after) } : {}),
      })));
      return {
        turns,
        recoveries: ledger.recoveries.map((item) => item.commit),
        ...(unfinished ? { unfinished } : {}),
      };
    });
  }

  async undo(project: ProjectState, turnId: string): Promise<CheckpointUndoResult> {
    return this.#serialize(project, async () => {
      const ledger = await this.#read(project);
      const entry = ledger.turns.find((turn) => turn.turnId === turnId && turn.after);
      if (!entry?.after) throw new Error("Completed Agent checkpoint not found");
      if (await this.store.unfinished(project)) throw new Error("Recover the interrupted checkpoint operation first");
      // A recovery itself must also preserve the complete current state.
      await assertCheckpointCapacity(project, this.maxBytes);
      // With no override, a later user edit makes the undo fail atomically.
      const result = await this.store.undo(project, { before: entry.before, after: entry.after });
      ledger.recoveries.push({ commit: result.previous, createdAt: new Date().toISOString() });
      await this.#write(project, ledger);
      return { ...result, previous: await this.#trimRecoveries(project, ledger, result.previous) };
    });
  }

  async restore(project: ProjectState, commit: string): Promise<CheckpointRestoreResult> {
    return this.#serialize(project, async () => {
      if (!COMMIT_ID.test(commit)) throw new Error("Invalid checkpoint ID");
      const ledger = await this.#read(project);
      const unfinished = await this.store.unfinished(project);
      const known = ledger.turns.some((turn) => turn.before === commit || turn.after === commit)
        || ledger.recoveries.some((recovery) => recovery.commit === commit)
        || unfinished === commit;
      if (!known) throw new Error("Checkpoint is not recorded for this project");
      await assertCheckpointCapacity(project, this.maxBytes);
      const result = await this.store.restore(project, commit);
      ledger.recoveries.push({ commit: result.previous, createdAt: new Date().toISOString() });
      await this.#write(project, ledger);
      return { ...result, previous: await this.#trimRecoveries(project, ledger, result.previous) };
    });
  }

  /**
   * Keep at most the most recent 20 turns. When space is scarce, first
   * compact older completed history rather than deleting live game files.
   * Recovery copies and the latest turn remain available.
   */
  async #prepare(project: ProjectState, history: CheckpointLedger): Promise<CheckpointLedger> {
    let ledger = history;
    if (ledger.turns.length > CHECKPOINT_MAX_TURNS) {
      ledger = await compactCheckpointHistory(project, ledger);
    }
    try {
      await assertCheckpointCapacity(project, this.maxBytes);
      return ledger;
    } catch (initialError) {
      for (let retain = ledger.turns.length - 1; retain >= 1; retain -= 1) {
        ledger = await compactCheckpointHistory(project, ledger, retain);
        try {
          await assertCheckpointCapacity(project, this.maxBytes);
          return ledger;
        } catch {
          // Keep the last snapshot until there is enough space for a new one.
        }
      }
      throw initialError;
    }
  }

  /** Bound recovery-only use as well as Agent turn history. */
  async #trimRecoveries(project: ProjectState, ledger: CheckpointLedger, previous: string): Promise<string> {
    if (ledger.recoveries.length <= 4) return previous;
    // A completed restore must remain successful even if optional compaction
    // fails: the uncompressed history is still complete on disk.
    try {
      const trimmed = await compactCheckpointHistory(project, ledger);
      return trimmed.recoveries.at(-1)?.commit ?? previous;
    } catch {
      return previous;
    }
  }

  async #read(project: ProjectState): Promise<CheckpointLedger> {
    let raw: string;
    try {
      raw = await readFile(this.#file(project), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing ledger is normal before the very first checkpoint only.
        // If loose snapshots already exist, silently recreating the ledger
        // would orphan the user's recorded restore history.
        const refFile = path.join(checkpointDirectory(project), "refs", "heads", "checkpoints");
        try {
          // Even an unreadable/damaged branch reference means this was not an
          // unused store. Refusing to replace the ledger preserves evidence
          // needed to recover the original history.
          await lstat(refFile);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, turns: [], recoveries: [] };
          throw cause;
        }
        throw new Error("Agent checkpoint history is missing while snapshots still exist; refusing to overwrite recovery history");
      }
      throw error;
    }
    const ledger: unknown = JSON.parse(raw);
    if (!isLedger(ledger)) throw new Error("Agent checkpoint ledger is damaged; refusing to overwrite it");
    return ledger;
  }

  async #write(project: ProjectState, ledger: CheckpointLedger): Promise<void> {
    const file = this.#file(project);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #file(project: ProjectState): string {
    if (!project.storagePath) throw new Error("Project has no private checkpoint storage");
    return path.join(checkpointDirectory(project), "agent-turns.json");
  }

  #serialize<T>(project: ProjectState, action: () => Promise<T>): Promise<T> {
    const key = project.id;
    const safe = async () => {
      await recoverCheckpointRotation(project);
      return action();
    };
    const next = (this.#queues.get(key) ?? Promise.resolve()).then(safe, safe);
    const settled = next.catch(() => undefined);
    this.#queues.set(key, settled);
    void settled.then(() => { if (this.#queues.get(key) === settled) this.#queues.delete(key); });
    return next;
  }
}

function isLedger(value: unknown): value is CheckpointLedger {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CheckpointLedger>;
  return data.version === 1
    && Array.isArray(data.turns)
    && data.turns.every((turn) => turn && typeof turn.turnId === "string" && typeof turn.conversationId === "string"
      && COMMIT_ID.test(turn.before) && (turn.after === undefined || COMMIT_ID.test(turn.after))
      && typeof turn.startedAt === "string" && (turn.finishedAt === undefined || typeof turn.finishedAt === "string"))
    && Array.isArray(data.recoveries)
    && data.recoveries.every((item) => item && COMMIT_ID.test(item.commit) && typeof item.createdAt === "string");
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { CheckpointStore, checkpointDirectory, type CheckpointRestoreResult, type CheckpointUndoResult } from "./checkpoints.js";

const COMMIT_ID = /^[a-f0-9]{40}$/;

export interface AgentCheckpointTurn {
  turnId: string;
  conversationId: string;
  before: string;
  after?: string;
  startedAt: string;
  finishedAt?: string;
}

interface CheckpointLedger {
  version: 1;
  turns: AgentCheckpointTurn[];
  recoveries: Array<{ commit: string; createdAt: string }>;
}

/** Project-private manifest; snapshots themselves are kept in CheckpointStore's Git objects. */
export class AgentCheckpoints {
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store = new CheckpointStore()) {}

  async before(project: ProjectState, conversationId: string, turnId: string): Promise<void> {
    await this.#serialize(project, async () => {
      const unfinished = await this.store.unfinished(project);
      if (unfinished) throw new Error("A previous checkpoint restore was interrupted; recover it before running the Agent");
      const ledger = await this.#read(project);
      if (ledger.turns.some((entry) => entry.turnId === turnId)) throw new Error("An Agent checkpoint already exists for this turn");
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
      const after = await this.store.snapshot(project);
      entry.after = after;
      entry.finishedAt = new Date().toISOString();
      await this.#write(project, ledger);
    });
  }

  async list(project: ProjectState): Promise<{ turns: AgentCheckpointTurn[]; recoveries: string[]; unfinished?: string }> {
    return this.#serialize(project, async () => {
      const ledger = await this.#read(project);
      const unfinished = await this.store.unfinished(project);
      return {
        turns: [...ledger.turns].reverse(),
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
      // With no override, a later user edit makes the undo fail atomically.
      const result = await this.store.undo(project, { before: entry.before, after: entry.after });
      ledger.recoveries.push({ commit: result.previous, createdAt: new Date().toISOString() });
      await this.#write(project, ledger);
      return result;
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
      const result = await this.store.restore(project, commit);
      ledger.recoveries.push({ commit: result.previous, createdAt: new Date().toISOString() });
      await this.#write(project, ledger);
      return result;
    });
  }

  async #read(project: ProjectState): Promise<CheckpointLedger> {
    let raw: string;
    try {
      raw = await readFile(this.#file(project), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, turns: [], recoveries: [] };
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
    const next = (this.#queues.get(key) ?? Promise.resolve()).then(action, action);
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

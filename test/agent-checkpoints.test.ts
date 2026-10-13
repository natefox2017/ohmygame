import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { AgentCheckpoints } from "../src/daemon/agent-checkpoints.js";
import { CheckpointConflictError } from "../src/daemon/checkpoints.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ project: ProjectState; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-checkpoints-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  const file = path.join(workspacePath, "game.txt");
  await writeFile(file, "version one\n");
  return {
    project: { id: randomUUID(), workspacePath, storagePath: path.join(root, "state") } as ProjectState,
    file,
  };
}

describe("AgentCheckpoints", () => {
  it("records a before/after range and undoes only an Agent edit", async () => {
    const { project, file } = await fixture();
    const checkpoints = new AgentCheckpoints();
    await checkpoints.before(project, "conversation-1", "turn-1");
    await writeFile(file, "version two\n");
    await checkpoints.after(project, "turn-1");
    const saved = await checkpoints.list(project);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]).toMatchObject({ turnId: "turn-1", conversationId: "conversation-1" });
    expect(saved.turns[0].after).toMatch(/^[a-f0-9]{40}$/);
    const undo = await checkpoints.undo(project, "turn-1");
    expect(undo.changed).toEqual(["game.txt"]);
    expect(await readFile(file, "utf8")).toBe("version one\n");
    // A reversible restore keeps the exact previously generated game available.
    await checkpoints.restore(project, undo.previous);
    expect(await readFile(file, "utf8")).toBe("version two\n");
  });

  it("rejects undo if the user changed a file after the Agent turn", async () => {
    const { project, file } = await fixture();
    const checkpoints = new AgentCheckpoints();
    await checkpoints.before(project, "conversation-1", "turn-1");
    await writeFile(file, "Agent edit\n");
    await checkpoints.after(project, "turn-1");
    await writeFile(file, "User change\n");
    await expect(checkpoints.undo(project, "turn-1")).rejects.toBeInstanceOf(CheckpointConflictError);
    expect(await readFile(file, "utf8")).toBe("User change\n");
  });

  it("preserves checkpoint identities through a fresh service instance", async () => {
    const { project, file } = await fixture();
    await new AgentCheckpoints().before(project, "c", "t");
    await writeFile(file, "new\n");
    await new AgentCheckpoints().after(project, "t");
    const reloaded = new AgentCheckpoints();
    expect((await reloaded.list(project)).turns[0].after).toMatch(/^[a-f0-9]{40}$/);
    await reloaded.undo(project, "t");
    expect(await readFile(file, "utf8")).toBe("version one\n");
  });

  it("rejects unknown restore targets without touching the workspace", async () => {
    const { project, file } = await fixture();
    const checkpoints = new AgentCheckpoints();
    await checkpoints.before(project, "c", "t");
    await expect(checkpoints.restore(project, "1".repeat(40))).rejects.toThrow("not recorded");
    expect(await readFile(file, "utf8")).toBe("version one\n");
  });

  it("fails closed on damaged persisted checkpoint history", async () => {
    const { project } = await fixture();
    const file = path.join(project.storagePath!, "checkpoints", "agent-turns.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"turns":"invalid"}');
    await expect(new AgentCheckpoints().before(project, "c", "t")).rejects.toThrow("damaged");
  });
});

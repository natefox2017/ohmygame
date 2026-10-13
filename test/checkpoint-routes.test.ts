import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AgentCheckpoints } from "../src/daemon/agent-checkpoints.js";
import type { ProjectState } from "../src/shared/contracts.js";

const opened: Array<{ app: ReturnType<typeof createApp>; folder: string }> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(async ({ app, folder }) => {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }));
});

async function project(preHandler?: (request: { method: string; url: string }) => Promise<void>) {
  const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-checkpoint-api-"));
  const app = createApp({ dataDirectory: folder });
  if (preHandler) app.addHook("preHandler", async (request) => preHandler(request));
  opened.push({ app, folder });
  const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "Recovery test" } });
  expect(response.statusCode, response.body).toBe(201);
  const state = response.json() as ProjectState;
  const file = path.join(state.workspacePath, "game.txt");
  await writeFile(file, "before\n");
  const checkpoints = new AgentCheckpoints();
  await checkpoints.before(state, "conversation", "turn-1");
  await writeFile(file, "after\n");
  await checkpoints.after(state, "turn-1");
  return { app, state, file };
}

describe("checkpoint recovery API", () => {
  it("lists changed paths and requires explicit confirmation to undo", async () => {
    const { app, state, file } = await project();
    const base = `/projects/${state.id}/checkpoints`;
    const history = await app.inject({ method: "GET", url: base });
    expect(history.statusCode).toBe(200);
    expect(history.json().turns[0]).toMatchObject({
      turnId: "turn-1",
      changes: [{ path: "game.txt", kind: "modified" }],
    });
    const refused = await app.inject({ method: "POST", url: base + "/undo", payload: { turnId: "turn-1" } });
    expect(refused.statusCode).toBe(400);
    expect(await readFile(file, "utf8")).toBe("after\n");

    const undone = await app.inject({ method: "POST", url: base + "/undo", payload: { turnId: "turn-1", confirm: true } });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(await readFile(file, "utf8")).toBe("before\n");

    const recovered = await app.inject({ method: "POST", url: base + "/restore", payload: { commit: undone.json().previous, confirm: true } });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await readFile(file, "utf8")).toBe("after\n");
  });

  it("refuses recovery while an editor mutation is in flight", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state, file } = await project(async (request) => {
      if (request.method === "PATCH" && /^\\/projects\\/[0-9a-f-]+$/i.test(request.url)) {
        entered();
        await gate;
      }
    });
    const saving = app.inject({ method: "PATCH", url: `/projects/${state.id}`, payload: { name: "Concurrent update" } });
    await started;
    try {
      const blocked = await app.inject({
        method: "POST",
        url: `/projects/${state.id}/checkpoints/undo`,
        payload: { turnId: "turn-1", confirm: true },
      });
      expect(blocked.statusCode).toBe(409);
      expect(await readFile(file, "utf8")).toBe("after\n");
    } finally {
      release();
    }
    expect((await saving).statusCode).toBe(200);
  });

  it("refuses unknown checkpoint ids and preserves the workspace", async () => {
    const { app, state, file } = await project();
    const response = await app.inject({
      method: "POST",
      url: `/projects/${state.id}/checkpoints/restore`,
      payload: { commit: "a".repeat(40), confirm: true },
    });
    expect(response.statusCode).toBe(409);
    expect(await readFile(file, "utf8")).toBe("after\n");
  });
});

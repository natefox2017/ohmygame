// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  listProjectCheckpoints: vi.fn(),
  undoProjectCheckpoint: vi.fn(),
  restoreProjectCheckpoint: vi.fn(),
}));
vi.mock("../src/renderer/api.js", () => api);
import { restoreCheckpointFromProjectMenu } from "../src/renderer/checkpoint-restore.js";

const project = { id: "00000000-0000-4000-8000-000000000000", name: "Test game" } as ProjectState;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("prompt", vi.fn(() => "1"));
  api.listProjectCheckpoints.mockResolvedValue({
    turns: [{ turnId: "turn-1", conversationId: "conversation", startedAt: "2026-10-13T00:00:00Z",
      before: "a".repeat(40), after: "b".repeat(40), changes: [{ path: "game.ts", kind: "modified" }] }],
    recoveries: [],
  });
  api.undoProjectCheckpoint.mockResolvedValue({ previous: "b".repeat(40), changed: ["game.ts"] });
  api.restoreProjectCheckpoint.mockResolvedValue({ previous: "a".repeat(40), changed: ["game.ts"] });
});

describe("project recovery menu", () => {
  it("shows modified files and uses the confirmed undo endpoint", async () => {
    expect(await restoreCheckpointFromProjectMenu(project)).toBe(true);
    expect(window.prompt).toHaveBeenCalledWith(expect.stringContaining("game.ts"), "1");
    expect(api.undoProjectCheckpoint).toHaveBeenCalledWith(project.id, "turn-1");
    expect(api.restoreProjectCheckpoint).not.toHaveBeenCalled();
  });

  it("does not send destructive requests without confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    expect(await restoreCheckpointFromProjectMenu(project)).toBe(false);
    expect(api.undoProjectCheckpoint).not.toHaveBeenCalled();
    expect(api.restoreProjectCheckpoint).not.toHaveBeenCalled();
  });

  it("can restore an interrupted operation using its preserved checkpoint", async () => {
    api.listProjectCheckpoints.mockResolvedValueOnce({ turns: [], recoveries: [], unfinished: "c".repeat(40) });
    expect(await restoreCheckpointFromProjectMenu(project)).toBe(true);
    expect(api.restoreProjectCheckpoint).toHaveBeenCalledWith(project.id, "c".repeat(40));
  });
});

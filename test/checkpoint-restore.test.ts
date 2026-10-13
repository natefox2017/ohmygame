// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  listProjectCheckpoints: vi.fn(),
  undoProjectCheckpoint: vi.fn(),
  restoreProjectCheckpoint: vi.fn(),
}));
vi.mock("../src/renderer/api.js", () => api);
import { ProjectCheckpointDialog } from "../src/renderer/checkpoint-restore.js";

const project = { id: "00000000-0000-4000-8000-000000000000", name: "Test game" } as ProjectState;
let host: HTMLDivElement;
let root: Root;
let recovered: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  recovered = vi.fn();
  api.listProjectCheckpoints.mockResolvedValue({
    turns: [{ turnId: "turn-1", conversationId: "conversation", startedAt: "2026-10-13T00:00:00Z",
      before: "a".repeat(40), after: "b".repeat(40), changes: [{ path: "game.ts", kind: "modified" }] }],
    recoveries: [],
  });
  api.undoProjectCheckpoint.mockResolvedValue({ previous: "b".repeat(40), changed: ["game.ts"] });
  api.restoreProjectCheckpoint.mockResolvedValue({ previous: "a".repeat(40), changed: ["game.ts"] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function openDialog() {
  await act(async () => {
    root.render(createElement(ProjectCheckpointDialog, { project, onClose: vi.fn(), onRecovered: recovered }));
  });
}

async function clickLabel(part: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(part));
  expect(button, `Missing button: ${part}`).toBeTruthy();
  await act(async () => { button!.click(); });
}

describe("project checkpoint modal", () => {
  it("shows files, requires two-step confirmation, then calls the undo endpoint", async () => {
    await openDialog();
    expect(host.textContent).toContain("game.ts");
    await clickLabel("Undo Agent turn");
    await clickLabel("Continue");
    expect(api.undoProjectCheckpoint).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Confirm recovery");
    await clickLabel("Confirm restore");
    expect(api.undoProjectCheckpoint).toHaveBeenCalledWith(project.id, "turn-1");
    expect(recovered).toHaveBeenCalled();
  });

  it("never sends destructive calls when no recovery point was selected", async () => {
    await openDialog();
    const continueButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Continue"));
    expect(continueButton?.disabled).toBe(true);
    expect(api.undoProjectCheckpoint).not.toHaveBeenCalled();
  });

  it("offers a safe explicit action for a previous interrupted restore", async () => {
    api.listProjectCheckpoints.mockResolvedValueOnce({ turns: [], recoveries: [], unfinished: "c".repeat(40) });
    await openDialog();
    expect(host.textContent).toContain("Recover interrupted restore");
    await clickLabel("Recover interrupted restore");
    await clickLabel("Continue");
    await clickLabel("Confirm restore");
    expect(api.restoreProjectCheckpoint).toHaveBeenCalledWith(project.id, "c".repeat(40));
  });
});

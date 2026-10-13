// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  waitForRuntime: vi.fn(),
  listProjects: vi.fn(),
  getProjectCover: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), () => api);
vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), () => ({
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/use-project-activity.ts"), () => ({
  useProjectActivity: () => new Map(),
}));
vi.doMock(path.resolve("src/renderer/use-project-shelf-layout.ts"), () => ({
  useProjectShelfLayout: () => ({ sectionRef: { current: null }, columns: 4, recentProjectLimit: 4 }),
}));
vi.doMock(path.resolve("src/renderer/examples.tsx"), () => ({
  useExamples: () => ({ examples: [], covers: {} }),
  ExampleShelf: () => null,
}));
vi.doMock(path.resolve("src/renderer/app-sidebar.tsx"), () => ({ AppSidebar: () => null }));
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({ ProjectPromptCreator: () => null }));
vi.doMock(path.resolve("src/renderer/window-drag-region.tsx"), () => ({ WindowDragRegion: () => null }));
vi.doMock(path.resolve("src/renderer/project-create-dialog.tsx"), () => ({ ProjectCreateDialog: () => null }));
vi.doMock(path.resolve("src/renderer/project-rename-dialog.tsx"), () => ({ ProjectRenameDialog: () => null }));
vi.doMock(path.resolve("src/renderer/checkpoint-restore.tsx"), () => ({
  ProjectCheckpointDialog: ({ project, onRecovered }: { project: ProjectState; onRecovered: () => void }) => (
    <div role="dialog" aria-label="Restore version">
      <span>Restore {project.name}</span>
      <button type="button" onClick={onRecovered}>Recovered</button>
    </div>
  ),
}));
const { Home } = await import("../src/renderer/home.js");

const project = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Test game",
  type: "web-game",
  updatedAt: "2026-10-13T00:00:00Z",
  workspacePath: "/tmp/ohmygame-test-game",
  preview: { status: "waiting" },
} as ProjectState;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.waitForRuntime.mockResolvedValue(undefined);
  api.listProjects.mockResolvedValue([project]);
  api.getProjectCover.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(<Home onNavigate={() => {}} onOpen={() => {}} onCreate={() => {}} />);
  });
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Project actions for Test game"]')).not.toBeNull());
}

it("opens existing recovery dialog from a recent project's Home card and refreshes after recovery", async () => {
  await render();
  const menuButton = host.querySelector<HTMLButtonElement>('[aria-label="Project actions for Test game"]');
  await act(async () => menuButton!.click());
  const restore = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === "Restore version");
  expect(restore).toBeDefined();
  await act(async () => restore!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Restore version"]');
  expect(dialog?.textContent).toContain("Restore Test game");
  await act(async () => dialog!.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector('[role="dialog"][aria-label="Restore version"]')).toBeNull();
  expect(api.listProjects).toHaveBeenCalledTimes(2);
});

// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexImageConnectionStatus, ProviderSummary } from "../src/shared/contracts.js";

const api = {
  status: vi.fn(),
  login: vi.fn(),
  cancel: vi.fn(),
  enabled: vi.fn(),
  setDefault: vi.fn(),
  catalog: vi.fn(),
};
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getCodexImageConnection: api.status,
  connectCodexImages: api.login,
  cancelCodexImageLogin: api.cancel,
  setProviderEnabled: api.enabled,
  setDefaultMediaModel: api.setDefault,
  listImageModelCatalog: api.catalog,
  MODELS_CHANGED_EVENT: "ohmygame-models-changed",
  notifyAgentModelsChanged: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => ({ state: { status: "signed-in", user: { id: "u", name: "Tester" } }, openSignIn: vi.fn() }),
}));
vi.doMock(path.resolve("src/renderer/provider-models.tsx"), () => ({ ProviderModels: () => null }));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");

const provider: ProviderSummary = {
  id: "codex-app-server",
  name: "Codex · ChatGPT Images",
  configured: false,
  enabled: false,
  status: "not_configured",
  capabilities: ["image"],
  methods: [{ type: "oauth", label: "ChatGPT" }],
};
const status: CodexImageConnectionStatus = {
  available: false, installed: true, connecting: false, enabled: false, message: "Sign in required",
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.status.mockResolvedValue(status);
  api.login.mockResolvedValue({ ...status, connecting: true });
  api.cancel.mockResolvedValue(undefined);
  api.enabled.mockResolvedValue({ ...provider, configured: true, enabled: true });
  api.setDefault.mockResolvedValue(undefined);
  api.catalog.mockResolvedValue({
    models: [{ provider: "codex-app-server", id: "gpt-image-2", name: "Codex Image (automatic size)" }],
    providers: [],
  });
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
  await act(async () => root.render(<ModelsSettings view={{ page: "provider", provider }} onViewChange={() => {}} />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  expect(button, `Missing button: ${text}`).toBeDefined();
  await act(async () => button!.click());
}
it("offers in-app ChatGPT connection instead of telling users to set an environment variable", async () => {
  await render();
  expect(host.textContent).toContain("Connect ChatGPT");
  expect(host.textContent).not.toContain("OHMYGAME_ENABLE_CODEX_IMAGES");
  await click("Connect ChatGPT");
  expect(api.login).toHaveBeenCalledOnce();
});
it("enables Codex and selects only the image model without altering programming models", async () => {
  api.status.mockResolvedValue({ ...status, available: true, enabled: false, message: "Signed in with ChatGPT" });
  await render();
  expect(host.textContent).toContain("Use Codex for images");
  await click("Use Codex for images");
  expect(api.enabled).toHaveBeenCalledWith("codex-app-server", true);
  expect(api.setDefault).toHaveBeenCalledWith("image", { provider: "codex-app-server", id: "gpt-image-2" });
  expect(host.textContent).toContain("default image-generation model");
});
it("shows the official CLI installation link when Codex cannot be found", async () => {
  api.status.mockResolvedValue({ ...status, installed: false, message: "Codex CLI missing" });
  await render();
  expect(host.textContent).toContain("Get Codex CLI");
  expect(host.textContent).not.toContain("Connect ChatGPT");
});

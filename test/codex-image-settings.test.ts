import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { CodexSubscriptionImages } from "../src/daemon/codex-image.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(installed = true) {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-codex-ui-"));
  roots.push(root);
  const binary = path.join(root, "fake-codex.mjs");
  const signedIn = path.join(root, "chatgpt-signin");
  await writeFile(binary, [
    'import { existsSync, writeFileSync } from "node:fs";',
    'const signedIn = ' + JSON.stringify(signedIn) + ';',
    'if (process.argv[2] === "login" && process.argv[3] === "status") {',
    '  console.log(existsSync(signedIn) ? "Logged in using ChatGPT" : "Not logged in");',
    '} else if (process.argv[2] === "login") {',
    '  writeFileSync(signedIn, "signed in");',
    '} else { process.exitCode = 1; }',
  ].join("\n"));
  const codex = installed ? new CodexSubscriptionImages(process.execPath, [binary])
    : new CodexSubscriptionImages(path.join(root, "missing-codex"));
  const runtime = await ModelRuntime.create({
    authPath: path.join(root, "auth.json"), modelsPath: path.join(root, "models.json"),
    modelsStorePath: path.join(root, "catalog.json"), allowModelNetwork: false,
  });
  const app = createApp({ dataDirectory: root, piAgentDirectory: root, codexImages: codex,
    createModelRuntime: async () => runtime });
  apps.push(app);
  return { root, app, signedIn };
}

describe("Codex image configuration through Providers & Models", () => {
  it("lists a disconnected Codex image provider even before installing the CLI", async () => {
    const { app } = await fixture(false);
    const listed = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(listed).toContainEqual(expect.objectContaining({
      id: "codex-app-server", capabilities: ["image"], configured: false, enabled: false,
    }));
    const status = await app.inject({ method: "GET", url: "/settings/models/providers/codex-app-server/status" });
    expect(status.json()).toMatchObject({ available: false, installed: false, enabled: false });
    const login = await app.inject({ method: "POST", url: "/settings/models/providers/codex-app-server/login" });
    expect(login.statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models)
      .not.toContainEqual(expect.objectContaining({ provider: "codex-app-server" }));
  });

  it("signs in, enables Codex images, selects the default and persists it independently of OpenAI", async () => {
    const { root, app, signedIn } = await fixture();
    expect(existsSync(signedIn)).toBe(false);
    const before = await app.inject({ method: "GET", url: "/settings/models/providers/codex-app-server/status" });
    expect(before.json()).toMatchObject({ installed: true, available: false, enabled: false });
    const started = await app.inject({ method: "POST", url: "/settings/models/providers/codex-app-server/login" });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/settings/models/providers/codex-app-server/status?refresh=true" });
      expect(response.json()).toMatchObject({ installed: true, available: true, connecting: false, enabled: false });
    }, { timeout: 5_000, interval: 70 });
    expect(existsSync(signedIn)).toBe(true);
    const connected = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(connected).toContainEqual(expect.objectContaining({
      id: "codex-app-server", status: "connected", configured: true, enabled: false,
    }));
    const activated = await app.inject({
      method: "PATCH", url: "/settings/models/providers/codex-app-server/enabled", payload: { enabled: true },
    });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toMatchObject({ id: "codex-app-server", enabled: true });
    const catalog = (await app.inject({ method: "GET", url: "/image-models/catalog" })).json();
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: "codex-app-server", id: "gpt-image-2" }));
    const selected = await app.inject({
      method: "PUT", url: "/image-models/default", payload: { provider: "codex-app-server", id: "gpt-image-2" },
    });
    expect(selected.statusCode, selected.body).toBe(204);
    const store = new ProviderModelSettingsStore(root, root);
    await store.load();
    expect(store.isEnabled("codex-app-server")).toBe(true);
    expect(store.defaultImageModel()).toEqual({ provider: "codex-app-server", id: "gpt-image-2" });
    expect(store.isEnabled("openai")).toBe(true);
    const disabled = await app.inject({
      method: "PATCH", url: "/settings/models/providers/codex-app-server/enabled", payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models)
      .not.toContainEqual(expect.objectContaining({ provider: "codex-app-server" }));
    const reopened = new ProviderModelSettingsStore(root, root);
    await reopened.load();
    expect(reopened.isEnabled("codex-app-server")).toBe(false);
    expect(reopened.defaultImageModel()).toEqual({ provider: "codex-app-server", id: "gpt-image-2" });
  });

  it("never permits enabling a disconnected Codex provider or selecting a phantom model", async () => {
    const { app } = await fixture(false);
    const enable = await app.inject({
      method: "PATCH", url: "/settings/models/providers/codex-app-server/enabled", payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(400);
    const select = await app.inject({
      method: "PUT", url: "/image-models/default", payload: { provider: "codex-app-server", id: "gpt-image-2" },
    });
    expect(select.statusCode).toBe(400);
  });
});

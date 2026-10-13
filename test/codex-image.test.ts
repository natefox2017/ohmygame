import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSubscriptionImages } from "../src/daemon/codex-image.js";
import { ProviderImages, CODEX_IMAGE_PROVIDER, CODEX_IMAGE_MODEL_ID } from "../src/daemon/provider-images.js";

const roots: string[] = [];
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/W1cAAAAASUVORK5CYII=";

async function fakeCodex(mode: "ok" | "missing-image" | "failed-image" | "api-key" | "early-exit" = "ok"): Promise<CodexSubscriptionImages> {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-fake-codex-"));
  roots.push(root);
  const script = path.join(root, "codex.mjs");
  // A local JSON-RPC test double, never an outbound API request or subscription call.
  const code = [
    'import readline from "node:readline";',
    'const mode = ' + JSON.stringify(mode) + ';',
    'const png = ' + JSON.stringify(PNG_BASE64) + ';',
    'if (process.argv[2] === "login") {',
    '  process.stderr.write(mode === "api-key" ? "Logged in using an API key\\n" : "Logged in using ChatGPT\\n");',
    '} else {',
    '  if (mode === "early-exit") { process.stdin.destroy(); process.exit(0); }',
    '  const input = readline.createInterface({ input: process.stdin });',
    '  input.on("line", (line) => {',
    '    const call = JSON.parse(line);',
    '    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    '    if (call.method === "initialize") emit({ id: call.id, result: { userAgent: "fake" } });',
    '    if (call.method === "thread/start") emit({ id: call.id, result: { thread: { id: "thread-test" } } });',
    '    if (call.method === "turn/start") {',
    '      emit({ id: call.id, result: { turn: { id: "turn-test" } } });',
    '      if (mode !== "missing-image") emit({ method: "item/completed", params: { threadId: "thread-test", turnId: "turn-test", item: mode === "failed-image" ? { type: "imageGeneration", status: "failed", failure: { type: "usageLimitExceeded" } } : { type: "imageGeneration", status: "completed", result: png, savedPath: "/private/should-not-be-read.png" } } });',
    '      if (mode !== "failed-image") emit({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "turn-test" } } });',
    '    }',
    '  });',
    '}',
  ].join("\n");
  await writeFile(script, code);
  return new CodexSubscriptionImages(process.execPath, [script]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe("Codex subscription image provider", () => {
  it("detects a signed-in ChatGPT account and uses the supported image tool", async () => {
    const codex = await fakeCodex();
    await expect(codex.availability()).resolves.toMatchObject({ available: true });
    const image = await codex.generate({ prompt: "A tiny sprite" });
    expect(image.mediaType).toBe("image/png");
    expect(image.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("lists and generates a selectable Codex model without Pi OAuth or an OpenAI API key", async () => {
    const codex = await fakeCodex();
    const images = new ProviderImages(async () => { throw new Error("No Pi session"); }, fetch, undefined, () => true, { codex });
    const catalog = await images.catalog();
    expect(catalog.models).toEqual([expect.objectContaining({ provider: CODEX_IMAGE_PROVIDER, id: CODEX_IMAGE_MODEL_ID, protocol: "codex-app-server" })]);
    expect(catalog.providers).toEqual([expect.objectContaining({ provider: CODEX_IMAGE_PROVIDER, state: "ready" })]);
    await expect(images.generate({ prompt: "One pixel", imageModel: { provider: CODEX_IMAGE_PROVIDER, id: CODEX_IMAGE_MODEL_ID } }))
      .resolves.toMatchObject({ mediaType: "image/png" });
  });

  it("does not list the model for a Codex API-key login", async () => {
    const codex = await fakeCodex("api-key");
    expect((await codex.availability()).available).toBe(false);
    const catalog = await new ProviderImages(async () => { throw new Error("No Pi session"); }, fetch, undefined, () => true, { codex }).catalog();
    expect(catalog.models).toEqual([]);
  });

  it("fails when Codex returned only text rather than a generated image", async () => {
    const codex = await fakeCodex("missing-image");
    await expect(codex.generate({ prompt: "No output" })).rejects.toThrow("without invoking");
  });

  it("surfaces a subscription usage limit without falling back to a paid API", async () => {
    const codex = await fakeCodex("failed-image");
    await expect(codex.generate({ prompt: "An icon" })).rejects.toThrow("limit was reached");
  });

  it("rejects cleanly when Codex closes its input pipe during the handshake", async () => {
    const codex = await fakeCodex("early-exit");
    await expect(codex.generate({ prompt: "A sprite" }))
      .rejects.toThrow(/input closed|Unable to send|exited before producing|not running/);
  });

  it("rejects unsupported exact image dimensions and reference images", async () => {
    const codex = await fakeCodex();
    await expect(codex.generate({ prompt: "An icon", size: "1536x1024" })).rejects.toThrow("size automatically");
    await expect(codex.generate({ prompt: "An icon", images: [{ data: PNG_BASE64, mediaType: "image/png" }] })).rejects.toThrow("reference images");
  });

  it("does not advertise Codex if its executable is missing", async () => {
    const codex = new CodexSubscriptionImages("/missing/ohmygame-codex");
    expect(await codex.availability()).toMatchObject({ available: false });
  });

  it("respects cancellation before starting Codex", async () => {
    const codex = await fakeCodex();
    const controller = new AbortController();
    controller.abort();
    await expect(codex.generate({ prompt: "An icon" }, controller.signal)).rejects.toThrow("cancelled");
  });
});

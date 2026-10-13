import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import { sniffImageType } from "./image-format.js";

const runFile = promisify(execFile);
const MAX_RESPONSE_CHARS = 46 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 240_000;
const LOGIN_CACHE_MS = 60_000;

/** An optional, separate image provider. Never forwards Pi's OAuth credentials. */
export class CodexSubscriptionImages implements ImageGenerator {
  #login?: { checkedAt: number; available: boolean; message: string };

  constructor(
    private readonly command = process.env.OHMYGAME_CODEX_BINARY || "codex",
    private readonly argsPrefix: string[] = [],
  ) {}

  async availability(): Promise<{ available: boolean; message: string }> {
    if (this.#login && Date.now() - this.#login.checkedAt < LOGIN_CACHE_MS) return this.#login;
    let result: { available: boolean; message: string };
    try {
      const authEnv = { ...process.env, OPENAI_API_KEY: "", CODEX_API_KEY: "" };
      const reply = await runFile(this.command, [...this.argsPrefix, "login", "status"], {
        env: authEnv,
        timeout: 10_000,
        maxBuffer: 16_384,
      });
      const output = reply.stdout + "\n" + reply.stderr;
      result = output.includes("Logged in using ChatGPT")
        ? { available: true, message: "ChatGPT sign-in detected; image access depends on the account's Codex capabilities and limits." }
        : { available: false, message: "Codex must be signed in using ChatGPT (run codex login)." };
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      result = { available: false, message: missing ? "Install the official Codex CLI and sign in with ChatGPT." : "Codex ChatGPT login is unavailable. Run codex login status." };
    }
    this.#login = { ...result, checkedAt: Date.now() };
    return result;
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    if (signal?.aborted) throw new ImageGenerationError("Codex image generation was cancelled", 499);
    if (!input.prompt.trim()) throw new ImageGenerationError("An image prompt is required", 400);
    if (input.images?.length) throw new ImageGenerationError("This Codex adapter does not support reference images yet", 400);
    if (input.size && input.size !== "1024x1024") throw new ImageGenerationError("Codex chooses image size automatically; only the default size request is accepted", 400);
    if (input.resolution && input.resolution !== "1K" || input.aspectRatio && input.aspectRatio !== "1:1") {
      throw new ImageGenerationError("Codex chooses image size and aspect ratio automatically", 400);
    }
    const login = await this.availability();
    if (!login.available) throw new ImageGenerationError(login.message, 503);
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-codex-image-"));
    try {
      return await this.#execute(input.prompt, directory, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #execute(prompt: string, directory: string, signal?: AbortSignal): Promise<GeneratedImage> {
    // Keep the process in a private empty workspace, not in the user's game.
    const env = { ...process.env, OPENAI_API_KEY: "", CODEX_API_KEY: "" };
    const child = spawn(this.command, [...this.argsPrefix, "app-server"], {
      cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const decoder = new StringDecoder("utf8");
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let sequence = 0;
    let buffer = "";
    let stderr = "";
    let stopped = false;
    let currentThread: string | undefined;
    let acceptingImages = false;
    let output: GeneratedImage | undefined;
    let accept!: (value: GeneratedImage) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<GeneratedImage>((resolve, fail) => { accept = resolve; reject = fail; });

    const abortWith = (cause: Error) => {
      if (stopped) return;
      stopped = true;
      for (const request of pending.values()) request.reject(cause);
      pending.clear();
      reject(cause);
      child.kill();
    };
    const cancel = () => abortWith(new ImageGenerationError("Codex image generation was cancelled", 499));
    const timeout = setTimeout(() => abortWith(new ImageGenerationError("Codex image generation timed out", 504)), GENERATION_TIMEOUT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", (cause) => abortWith(new ImageGenerationError("Codex App Server could not start: " + cause.message, 503)));
    // A process that exits during initialization can close stdin between RPC
    // writes. Writable stream errors do not propagate through child.on("error")
    // and would otherwise be an unhandled exception in the desktop daemon.
    child.stdin.on("error", (cause) => abortWith(new ImageGenerationError("Codex App Server input closed: " + cause.message, 502)));
    child.on("exit", (code) => {
      if (!stopped) abortWith(new ImageGenerationError("Codex App Server exited before producing an image (code " + code + "). " + stderr.slice(-300), 502));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-600); });

    const rpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (stopped) return Promise.reject(new ImageGenerationError("Codex App Server is not running", 503));
      const id = ++sequence;
      return new Promise((resolve, rejectRequest) => {
        pending.set(id, { resolve, reject: rejectRequest });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (cause) => {
          if (cause) abortWith(new ImageGenerationError("Unable to send the Codex request", 502));
        });
      });
    };
    const notify = (method: string): void => {
      if (stopped) return;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n", (cause) => {
        if (cause) abortWith(new ImageGenerationError("Unable to send the Codex notification", 502));
      });
    };
    const onMessage = (message: Record<string, unknown>) => {
      if (typeof message.id === "number") {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error && typeof message.error === "object") {
          const detail = message.error as { message?: unknown };
          request.reject(new ImageGenerationError("Codex rejected " + String(detail.message ?? "the request"), 502));
        } else request.resolve(message.result);
        return;
      }
      if (!acceptingImages || !message.params || typeof message.params !== "object") return;
      const params = message.params as Record<string, unknown>;
      if (params.threadId !== currentThread) return;
      if (message.method === "item/completed") {
        const item = params.item as { type?: string; status?: string; result?: unknown; failure?: { type?: string } } | undefined;
        if (item?.type !== "imageGeneration") return;
        if (item.status === "failed") {
          abortWith(new ImageGenerationError(item.failure?.type === "usageLimitExceeded"
            ? "Codex subscription image generation limit was reached" : "Codex image generation failed", item.failure?.type === "usageLimitExceeded" ? 429 : 502));
          return;
        }
        if (item.status !== "completed") return;
        const base64 = item.result;
        if (typeof base64 !== "string" || base64.length < 12 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
          abortWith(new ImageGenerationError("Codex returned an invalid image payload", 502));
          return;
        }
        const bytes = Buffer.from(base64, "base64");
        const mediaType = sniffImageType(bytes);
        if (!mediaType || bytes.length > MAX_IMAGE_BYTES) {
          abortWith(new ImageGenerationError("Codex returned unsupported or oversized image content", 502));
          return;
        }
        // Prefer the official event's base64 result; never read a model-supplied path.
        output = { bytes, mediaType };
      }
      if (message.method === "turn/completed") {
        if (output) { stopped = true; accept(output); }
        else abortWith(new ImageGenerationError("Codex finished without invoking its image generation tool. Check your plan, selected Codex model and image-generation feature availability.", 503));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_RESPONSE_CHARS) return abortWith(new ImageGenerationError("Codex response exceeded the maximum image size", 502));
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try { onMessage(JSON.parse(line) as Record<string, unknown>); }
          catch { return abortWith(new ImageGenerationError("Codex App Server returned malformed JSON", 502)); }
        }
        newline = buffer.indexOf("\n");
      }
    });

    try {
      await rpc("initialize", { clientInfo: { name: "ohmygame", title: "OhMyGame image generation", version: "0.0.0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
      notify("initialized");
      const started = await rpc("thread/start", {
        cwd: directory, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true,
        config: { features: { image_generation: true } },
      }) as { thread?: { id?: string } };
      currentThread = started?.thread?.id;
      if (!currentThread) throw new ImageGenerationError("Codex returned no thread ID", 502);
      acceptingImages = true;
      await rpc("turn/start", {
        threadId: currentThread,
        input: [{ type: "text", text: "Generate exactly one image with image_gen.imagegen for this description: " + prompt
          + ". Use the built-in image generation tool. Do not write code, run commands, or replace the image with an SVG or text description.", text_elements: [] }],
      });
      return await completed;
    } finally {
      stopped = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      child.kill();
      child.stdin.end();
    }
  }
}

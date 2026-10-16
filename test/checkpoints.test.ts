import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileChangedError, readCommitTree, readTree, writeFileBlob } from "../src/daemon/checkpoint-objects.js";
import { CheckpointChangedError, CheckpointConflictError, CheckpointIncompleteError, CheckpointStore, checkpointDirectory } from "../src/daemon/checkpoints.js";

// Lets a test step in just before the store touches the file system, to stand in for another writer or a failing disk.
// `frozen` makes a file look the same as when it was frozen, as on a file system that keeps coarse times.
const interception = vi.hoisted(() => ({
  before: undefined as ((operation: "lstat" | "rm" | "rename", target: string) => Promise<void>) | undefined,
  frozen: new Map<string, Stats>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const intercepted = <T extends (...parameters: any[]) => Promise<unknown>>(operation: "lstat" | "rm" | "rename", run: T, target = 0) => (async (...parameters: Parameters<T>) => {
    await interception.before?.(operation, String(parameters[target]));
    return await run(...parameters);
  }) as T;
  const lstat = intercepted("lstat", (async (target: string) => interception.frozen.get(target) ?? await original.lstat(target)) as typeof original.lstat);
  const mocked = { ...original, lstat, rm: intercepted("rm", original.rm), rename: intercepted("rename", original.rename, 1) };
  return { ...mocked, default: mocked };
});

const caseInsensitive = (() => {
  const directory = mkdtempSync(path.join(tmpdir(), "ohmygame-checkpoints-case-"));
  writeFileSync(path.join(directory, "Probe"), "");
  const found = existsSync(path.join(directory, "probe"));
  rmSync(directory, { recursive: true, force: true });
  return found;
})();
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const roots: string[] = [];
afterEach(async () => {
  interception.before = undefined;
  interception.frozen.clear();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A project whose workspace holds these files, by path and content. */
async function project(files: Record<string, string>) {
  const storagePath = await mkdtemp(path.join(tmpdir(), "ohmygame-checkpoints-"));
  roots.push(storagePath);
  const workspacePath = path.join(storagePath, "workspace");
  await mkdir(workspacePath);
  await write(workspacePath, files);
  return { workspacePath, storagePath };
}

async function write(workspacePath: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true });
    await writeFile(path.join(workspacePath, file), content);
  }
}

/** Every file under a folder, by path and content. */
async function contents(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Array<[string, string]> = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...Object.entries(await contents(directory, entryPath)));
    else result.push([entryPath, await readFile(path.join(directory, entryPath), "utf8")]);
  }
  // Built from entries so that a file named `__proto__` is kept as well.
  return Object.fromEntries(result);
}

describe("workspace checkpoints", () => {
  it("puts changed, added and removed files back and reports them", async () => {
    const files = { "index.html": "<main></main>", "src/game.ts": "export const speed = 1;\n", "src/levels/one.json": "{}", "assets/hero.png": "hero" };
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await write(game.workspacePath, { "src/game.ts": "export const speed = 9;\n", "src/enemies/boss.ts": "export {};\n" });
    await rm(path.join(game.workspacePath, "src/levels"), { recursive: true });
    await rm(path.join(game.workspacePath, "assets/hero.png"));

    const restored = await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual(files);
    expect(restored.changed).toEqual(["assets/hero.png", "src/enemies/boss.ts", "src/game.ts", "src/levels/one.json"]);
    // The folder that held only the added file is gone with it.
    expect((await readdir(path.join(game.workspacePath, "src"))).sort()).toEqual(["game.ts", "levels"]);
  });

  it("reuses the commit when nothing changed, also without its file cache", async () => {
    const game = await project({ "index.html": "<main></main>", "src/game.ts": "export {};\n" });
    const store = new CheckpointStore();
    const first = await store.snapshot(game);
    expect(await store.snapshot(game)).toBe(first);
    await rm(path.join(checkpointDirectory(game), "ohmygame-stat-cache.json"));
    expect(await store.snapshot(game)).toBe(first);
    await writeFile(path.join(checkpointDirectory(game), "ohmygame-stat-cache.json"), "not json");
    expect(await new CheckpointStore().snapshot(game)).toBe(first);

    await write(game.workspacePath, { "src/game.ts": "export const changed = true;\n" });
    expect(await store.snapshot(game)).not.toBe(first);
  });

  it("keeps its store outside the workspace and writes nothing into the workspace", async () => {
    const files = { "index.html": "<main></main>" };
    const game = await project(files);
    await new CheckpointStore().snapshot(game);
    expect(await contents(game.workspacePath)).toEqual(files);
    expect(checkpointDirectory(game)).toBe(path.join(game.storagePath, "checkpoints"));
    expect((await readdir(game.storagePath)).sort()).toEqual(["checkpoints", "workspace"]);
  });

  it("leaves dependencies, version control, build output and caches out and never touches them", async () => {
    const kept = {
      "node_modules/phaser/index.js": "module.exports = 1;\n",
      "packages/ui/node_modules/react/index.js": "module.exports = 2;\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "vendor/engine/.Git/config": "[core]\n",
      "dist/index.js": "built",
      "build/index.js": "built",
      "out/index.js": "built",
      ".ohmygame/thumbnails/scene.png": "thumbnail",
      ".ohmygame-install-pending": "",
      ".data/agent-attachments/notes.txt": "attachment",
    };
    const game = await project({ ...kept, "src/game.ts": "one", "src/dist/tiles.json": "one", ".data/assets.json": "{\"one\":true}" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    const edited = Object.fromEntries(Object.keys(kept).map((file) => [file, "changed after the snapshot"]));
    await write(game.workspacePath, { ...edited, "node_modules/added/index.js": "new", "src/game.ts": "two", "src/dist/tiles.json": "two", ".data/assets.json": "{}" });

    const restored = await store.restore(game, before);
    expect(restored.changed).toEqual([".data/assets.json", "src/dist/tiles.json", "src/game.ts"]);
    expect(await contents(game.workspacePath)).toEqual({
      ...edited,
      "node_modules/added/index.js": "new",
      "src/game.ts": "one",
      "src/dist/tiles.json": "one",
      ".data/assets.json": "{\"one\":true}",
    });
  });

  it("ignores the workspace's own .gitignore", async () => {
    const game = await project({ ".gitignore": "*.png\nsecret.txt\n", "assets/hero.png": "hero", "secret.txt": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "assets/hero.png": "changed", "secret.txt": "two" });
    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toMatchObject({ "assets/hero.png": "hero", "secret.txt": "one" });
  });

  it("restores a file where a folder was and a folder where a file was", async () => {
    const files = { "levels": "all levels in one file", "enemies/boss.ts": "boss", "enemies/minion.ts": "minion" };
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await rm(path.join(game.workspacePath, "levels"));
    await rm(path.join(game.workspacePath, "enemies"), { recursive: true });
    await write(game.workspacePath, { "levels/one.json": "{}", "levels/two.json": "{}", "enemies": "all enemies in one file" });

    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual(files);
  });

  it.skipIf(process.platform === "win32")("keeps executable files and symbolic links as they were", async () => {
    const game = await project({ "tools/build.sh": "#!/bin/sh\n", "src/game.ts": "export {};\n" });
    await chmod(path.join(game.workspacePath, "tools/build.sh"), 0o755);
    await symlink("src/game.ts", path.join(game.workspacePath, "entry.ts"));
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await chmod(path.join(game.workspacePath, "tools/build.sh"), 0o644);
    await rm(path.join(game.workspacePath, "entry.ts"));
    await writeFile(path.join(game.workspacePath, "entry.ts"), "no longer a link");

    await store.restore(game, before);
    expect((await lstat(path.join(game.workspacePath, "tools/build.sh"))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(game.workspacePath, "entry.ts"))).toBe("src/game.ts");
  });

  it("can take a restore back", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two", "src/added.ts": "added" });

    const restored = await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one" });
    await store.restore(game, restored.previous);
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two", "src/added.ts": "added" });
  });

  it("refuses a damaged target blob before removing or overwriting any game files", async () => {
    const game = await project({ "game.ts": "version one", "keep.ts": "keep original" });
    const store = new CheckpointStore();
    const original = await store.snapshot(game);
    const gitdir = checkpointDirectory(game);
    const entries = await readTree(gitdir, await readCommitTree(gitdir, original));
    const target = entries.find((entry) => entry.name === "game.ts");
    expect(target).toBeDefined();

    // Current workspace has both an edited file and an added user file that
    // a full restore would ordinarily replace/remove.
    await write(game.workspacePath, { "game.ts": "version two", "draft.ts": "user draft" });
    const current = await contents(game.workspacePath);
    await writeFile(path.join(gitdir, "objects", target!.oid.slice(0, 2), target!.oid.slice(2)), "damaged object");

    await expect(store.restore(game, original)).rejects.toThrow(/damaged|object/i);
    expect(await contents(game.workspacePath)).toEqual(current);
    await expect(readFile(path.join(gitdir, "ohmygame-unfinished.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a damaged undo target before modifying the game", async () => {
    const game = await project({ "game.ts": "before" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "game.ts": "after", "agent-added.ts": "generated" });
    const after = await store.snapshot(game);
    const gitdir = checkpointDirectory(game);
    const target = (await readTree(gitdir, await readCommitTree(gitdir, before)))
      .find((entry) => entry.name === "game.ts");
    expect(target).toBeDefined();
    await writeFile(path.join(gitdir, "objects", target!.oid.slice(0, 2), target!.oid.slice(2)), "damaged object");
    const current = await contents(game.workspacePath);

    await expect(store.undo(game, { before, after })).rejects.toThrow(/damaged|object/i);
    expect(await contents(game.workspacePath)).toEqual(current);
    await expect(readFile(path.join(gitdir, "ohmygame-unfinished.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("changes nothing when asked for a snapshot it does not have", async () => {
    const files = { "src/game.ts": "one" };
    const game = await project(files);
    const store = new CheckpointStore();
    await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two" });
    await expect(store.restore(game, "0".repeat(40))).rejects.toThrow();
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("puts files back when a restore fails part way", async () => {
    const game = await project({ "a/one.ts": "one", "locked/two.ts": "two" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    const after = { "a/one.ts": "changed one", "locked/two.ts": "changed two" };
    await write(game.workspacePath, after);
    // The restore can rewrite a/one.ts but cannot replace locked/two.ts.
    await chmod(path.join(game.workspacePath, "locked"), 0o555);
    try {
      await expect(store.restore(game, before)).rejects.toThrow();
    } finally {
      await chmod(path.join(game.workspacePath, "locked"), 0o755);
    }
    expect(await contents(game.workspacePath)).toEqual(after);
  });

  it("runs snapshots and restores of one project one at a time", async () => {
    const game = await project(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/file-${index}.ts`, `export const value = ${index};\n`])));
    const store = new CheckpointStore();
    const commits = await Promise.all(Array.from({ length: 6 }, () => store.snapshot(game)));
    expect(new Set(commits).size).toBe(1);

    await write(game.workspacePath, { "src/file-0.ts": "changed" });
    const [restored, snapshot] = await Promise.all([store.restore(game, commits[0]!), store.snapshot(game)]);
    expect(restored.changed).toEqual(["src/file-0.ts"]);
    // The snapshot queued behind the restore sees the restored workspace.
    expect(await store.restore(game, snapshot)).toMatchObject({ changed: [] });
  });

  it("trusts its file cache only for files that had time to settle", async () => {
    const game = await project({ "index.html": "<main></main>", "src/game.ts": "one" });
    const cacheFile = path.join(checkpointDirectory(game), "ohmygame-stat-cache.json");
    const cache = async () => JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, { oid: string }>;
    const store = new CheckpointStore();
    const text = async (commit: string, file: string) => Buffer.from((await store.read(game, commit, file))!).toString("utf8");
    const written = Math.max(...await Promise.all(["index.html", "src/game.ts"].map(async (file) => (await lstat(path.join(game.workspacePath, file))).ctimeMs)));

    // A second after they were written the files may still change again without their size or times showing it.
    vi.useFakeTimers({ toFake: ["Date"], now: written + 1_000 });
    const first = await store.snapshot(game);
    expect(Object.keys(await cache())).toEqual([]);

    vi.setSystemTime(written + 3_000);
    expect(await store.snapshot(game)).toBe(first);
    const cached = await cache();
    expect(Object.keys(cached).sort()).toEqual(["index.html", "src/game.ts"]);

    // A cached file is not read again: the snapshot takes what the cache says is in it.
    await writeFile(cacheFile, JSON.stringify({ ...cached, "index.html": { ...cached["index.html"], oid: cached["src/game.ts"]!.oid } }));
    const trusted = await store.snapshot(game);
    expect(await text(trusted, "index.html")).toBe("one");

    // A cached file that changes is read again, also when its size stays the same.
    await writeFile(cacheFile, JSON.stringify(cached));
    await write(game.workspacePath, { "src/game.ts": "two" });
    const second = await store.snapshot(game);
    expect(await store.diff(game, first, second)).toEqual([{ path: "src/game.ts", kind: "modified" }]);
    expect(await text(second, "src/game.ts")).toBe("two");
  });

  it("lists what changed between two snapshots and reads either side", async () => {
    const game = await project({ "index.html": "<main></main>", "src/game.ts": "one", "src/levels/one.json": "{}", "notes": "a file" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    expect(await store.diff(game, before, before)).toEqual([]);

    await write(game.workspacePath, { "src/game.ts": "two", "src/enemies/boss.ts": "boss" });
    await rm(path.join(game.workspacePath, "src/levels"), { recursive: true });
    await rm(path.join(game.workspacePath, "notes"));
    await write(game.workspacePath, { "notes/today.md": "a folder" });
    const after = await store.snapshot(game);

    expect(await store.diff(game, before, after)).toEqual([
      { path: "notes", kind: "removed" },
      { path: "notes/today.md", kind: "added" },
      { path: "src/enemies/boss.ts", kind: "added" },
      { path: "src/game.ts", kind: "modified" },
      { path: "src/levels/one.json", kind: "removed" },
    ]);
    expect(await store.diff(game, after, before)).toEqual([
      { path: "notes", kind: "added" },
      { path: "notes/today.md", kind: "removed" },
      { path: "src/enemies/boss.ts", kind: "removed" },
      { path: "src/game.ts", kind: "modified" },
      { path: "src/levels/one.json", kind: "added" },
    ]);

    const text = async (commit: string, file: string) => {
      const content = await store.read(game, commit, file);
      return content && Buffer.from(content).toString("utf8");
    };
    expect(await text(before, "src/game.ts")).toBe("one");
    expect(await text(after, "src/game.ts")).toBe("two");
    expect(await text(before, "src/enemies/boss.ts")).toBeUndefined();
    expect(await text(after, "src/levels/one.json")).toBeUndefined();
    // A folder is not a file, and a file has nothing below it.
    expect(await text(after, "src")).toBeUndefined();
    expect(await text(before, "notes/today.md")).toBeUndefined();
    await expect(store.diff(game, before, "0".repeat(40))).rejects.toThrow();
  });

  it("undoes one turn and keeps what was changed elsewhere afterwards", async () => {
    const game = await project({ "index.html": "<main></main>", "src/game.ts": "one", "src/old.ts": "old", "README.md": "readme" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two", "src/added.ts": "added" });
    await rm(path.join(game.workspacePath, "src/old.ts"));
    const after = await store.snapshot(game);
    // Later work in files the turn did not touch.
    await write(game.workspacePath, { "README.md": "edited later", "src/later.ts": "later" });

    const undone = await store.undo(game, { before, after });
    expect(undone.conflicts).toEqual([]);
    expect(undone.changed).toEqual(["src/added.ts", "src/game.ts", "src/old.ts"]);
    expect(await contents(game.workspacePath)).toEqual({
      "index.html": "<main></main>", "src/game.ts": "one", "src/old.ts": "old", "README.md": "edited later", "src/later.ts": "later",
    });

    // The undo can be taken back, and a second undo of the same turn then does the same again.
    await store.restore(game, undone.previous);
    expect(await contents(game.workspacePath)).toMatchObject({ "src/game.ts": "two", "src/added.ts": "added", "README.md": "edited later" });
    expect((await store.undo(game, { before, after })).changed).toEqual(["src/added.ts", "src/game.ts", "src/old.ts"]);
    expect(await store.undo(game, { before, after })).toMatchObject({ changed: [], conflicts: [] });
  });

  it("undoes an earlier turn below a later one", async () => {
    const game = await project({ "a.ts": "a0", "b.ts": "b0" });
    const store = new CheckpointStore();
    const first = await store.snapshot(game);
    await write(game.workspacePath, { "a.ts": "a1" });
    const second = await store.snapshot(game);
    await write(game.workspacePath, { "b.ts": "b1" });
    await store.snapshot(game);

    expect(await store.undo(game, { before: first, after: second })).toMatchObject({ changed: ["a.ts"], conflicts: [] });
    expect(await contents(game.workspacePath)).toEqual({ "a.ts": "a0", "b.ts": "b1" });
  });

  it("refuses an undo that would overwrite later changes, and touches nothing", async () => {
    const game = await project({ "edited.ts": "one", "removed.ts": "one", "clean.ts": "one", "by-hand.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "edited.ts": "two", "clean.ts": "two", "by-hand.ts": "two", "added.ts": "two", "added-then-removed.ts": "two" });
    await rm(path.join(game.workspacePath, "removed.ts"));
    const after = await store.snapshot(game);
    // Afterwards: two of the turn's files are edited again, one it removed is written anew,
    // one is put back by hand, and one it added is removed.
    const later = { "edited.ts": "three", "added.ts": "three", "removed.ts": "three", "by-hand.ts": "one" };
    await write(game.workspacePath, later);
    await rm(path.join(game.workspacePath, "added-then-removed.ts"));
    const current = { ...later, "clean.ts": "two" };

    const refused = await store.undo(game, { before, after }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CheckpointConflictError);
    expect((refused as CheckpointConflictError).conflicts).toEqual(["added.ts", "edited.ts", "removed.ts"]);
    expect(await contents(game.workspacePath)).toEqual(current);

    const kept = await store.undo(game, { before, after }, { conflicts: "keep" });
    expect(kept).toMatchObject({ changed: ["clean.ts"], conflicts: ["added.ts", "edited.ts", "removed.ts"] });
    expect(await contents(game.workspacePath)).toEqual({ ...later, "clean.ts": "one" });

    await store.restore(game, kept.previous);
    const overwritten = await store.undo(game, { before, after }, { conflicts: { overwrite: ["added.ts", "edited.ts", "removed.ts"] } });
    expect(overwritten.conflicts).toEqual(["added.ts", "edited.ts", "removed.ts"]);
    expect(overwritten.changed).toEqual(["added.ts", "clean.ts", "edited.ts", "removed.ts"]);
    expect(await contents(game.workspacePath)).toEqual({ "edited.ts": "one", "removed.ts": "one", "clean.ts": "one", "by-hand.ts": "one" });
    // What was overwritten is still in the snapshot taken just before.
    await store.restore(game, overwritten.previous);
    expect(await contents(game.workspacePath)).toEqual(current);
  });

  it("treats a later file in the way of an undo as a conflict", async () => {
    const files = { "levels": "all levels in one file", "enemies/boss.ts": "boss" };
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    // The turn turns a file into a folder and removes a folder.
    await rm(path.join(game.workspacePath, "levels"));
    await rm(path.join(game.workspacePath, "enemies"), { recursive: true });
    await write(game.workspacePath, { "levels/one.json": "{}" });
    const after = await store.snapshot(game);

    const clean = await store.undo(game, { before, after });
    expect(clean.conflicts).toEqual([]);
    expect(await contents(game.workspacePath)).toEqual(files);
    await store.restore(game, clean.previous);

    // Afterwards a file is added to the new folder, and a file takes the name of the removed folder.
    const later = { "levels/two.json": "{}", "enemies": "all enemies in one file" };
    await write(game.workspacePath, later);
    const current = { ...later, "levels/one.json": "{}" };

    const refused = await store.undo(game, { before, after }).catch((error: unknown) => error);
    // Show all conflicting paths, including the later files that obstruct restoration.
    expect((refused as CheckpointConflictError).conflicts).toEqual(["enemies", "enemies/boss.ts", "levels", "levels/two.json"]);
    expect(await contents(game.workspacePath)).toEqual(current);

    // Keeping the conflicts still removes what the turn added and nobody changed since.
    const kept = await store.undo(game, { before, after }, { conflicts: "keep" });
    expect(kept.changed).toEqual(["levels/one.json"]);
    expect(await contents(game.workspacePath)).toEqual(later);

    await store.restore(game, kept.previous);
    const overwritten = await store.undo(game, { before, after }, { conflicts: { overwrite: ["enemies", "enemies/boss.ts", "levels", "levels/two.json"] } });
    expect(overwritten.changed).toEqual(["enemies", "enemies/boss.ts", "levels", "levels/one.json", "levels/two.json"]);
    expect(await contents(game.workspacePath)).toEqual(files);
    await store.restore(game, overwritten.previous);
    expect(await contents(game.workspacePath)).toEqual(current);
  });

  it("leaves excluded files alone when it undoes", async () => {
    const game = await project({ "src/game.ts": "one", "node_modules/phaser/index.js": "one", "dist/index.js": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two", "node_modules/phaser/index.js": "two", "dist/index.js": "two" });
    const after = await store.snapshot(game);

    expect(await store.diff(game, before, after)).toEqual([{ path: "src/game.ts", kind: "modified" }]);
    await store.undo(game, { before, after });
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one", "node_modules/phaser/index.js": "two", "dist/index.js": "two" });
  });

  it("changes nothing when asked to undo snapshots it does not have", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two" });
    await expect(store.undo(game, { before, after: "0".repeat(40) })).rejects.toThrow();
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("puts files back when an undo fails part way", async () => {
    const game = await project({ "a/one.ts": "one", "locked/two.ts": "two" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    const changed = { "a/one.ts": "changed one", "locked/two.ts": "changed two" };
    await write(game.workspacePath, changed);
    const after = await store.snapshot(game);
    await chmod(path.join(game.workspacePath, "locked"), 0o555);
    try {
      await expect(store.undo(game, { before, after })).rejects.toThrow();
    } finally {
      await chmod(path.join(game.workspacePath, "locked"), 0o755);
    }
    expect(await contents(game.workspacePath)).toEqual(changed);
  });

  it("counts a file the turn added and that was changed later as being in the way", async () => {
    const game = await project({ "levels": "all levels in one file" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await rm(path.join(game.workspacePath, "levels"));
    await write(game.workspacePath, { "levels/one.json": "{}" });
    const after = await store.snapshot(game);
    const later = { "levels/one.json": "{ \"edited\": true }" };
    await write(game.workspacePath, later);

    const refused = await store.undo(game, { before, after }).catch((error: unknown) => error);
    expect((refused as CheckpointConflictError).conflicts).toEqual(["levels", "levels/one.json"]);
    expect(await store.undo(game, { before, after }, { conflicts: "keep" })).toMatchObject({ changed: [] });
    expect(await contents(game.workspacePath)).toEqual(later);
  });

  it("removes every folder an undo emptied", async () => {
    const game = await project({ "index.html": "<main></main>" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/levels/world/one.json": "{}" });
    const after = await store.snapshot(game);
    await store.undo(game, { before, after });
    expect(await readdir(game.workspacePath)).toEqual(["index.html"]);
  });

  it("never removes excluded files that are where a file must come back", async () => {
    const game = await project({ "tools": "a file", "levels": "a file", "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await rm(path.join(game.workspacePath, "tools"));
    await rm(path.join(game.workspacePath, "levels"));
    await write(game.workspacePath, { "src/game.ts": "two" });
    const after = await store.snapshot(game);
    // Afterwards a folder with nothing but dependencies takes one name, and empty folders take the other.
    const dependencies = { "tools/node_modules/dep/index.js": "module.exports = 1;\n" };
    await write(game.workspacePath, dependencies);
    await mkdir(path.join(game.workspacePath, "levels/world/one"), { recursive: true });
    const current = { ...dependencies, "src/game.ts": "two" };

    for (const refused of [store.restore(game, before), store.undo(game, { before, after }), store.undo(game, { before, after }, { conflicts: { overwrite: ["tools"] } })]) {
      const error = await refused.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CheckpointConflictError);
      expect((error as CheckpointConflictError).conflicts).toEqual(["tools"]);
      expect(await contents(game.workspacePath)).toEqual(current);
    }

    // Empty folders are not worth keeping: the file comes back in their place.
    expect(await store.undo(game, { before, after }, { conflicts: "keep" })).toMatchObject({ changed: ["levels", "src/game.ts"], conflicts: ["tools"] });
    expect(await contents(game.workspacePath)).toEqual({ ...dependencies, "levels": "a file", "src/game.ts": "one" });
  });

  it.skipIf(!caseInsensitive)("does not overwrite a file whose name differs only in case", async () => {
    const game = await project({ "README.md": "old readme", "Game.ts": "game" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    // The turn removes one file and gives the other a name in lower case.
    await rm(path.join(game.workspacePath, "README.md"));
    await rm(path.join(game.workspacePath, "Game.ts"));
    await write(game.workspacePath, { "game.ts": "game" });
    const after = await store.snapshot(game);

    const renamed = await store.undo(game, { before, after });
    expect(renamed.conflicts).toEqual([]);
    expect((await readdir(game.workspacePath)).sort()).toEqual(["Game.ts", "README.md"]);
    await store.restore(game, renamed.previous);

    // Afterwards a new file takes the removed file's name in another case, and the renamed file is edited.
    const later = { "Readme.md": "new readme", "game.ts": "edited later" };
    await write(game.workspacePath, later);
    const refused = await store.undo(game, { before, after }).catch((error: unknown) => error);
    expect((refused as CheckpointConflictError).conflicts).toEqual(["Game.ts", "README.md", "game.ts"]);
    expect(await store.undo(game, { before, after }, { conflicts: "keep" })).toMatchObject({ changed: [] });
    expect((await readdir(game.workspacePath)).sort()).toEqual(["Readme.md", "game.ts"]);
    expect(await contents(game.workspacePath)).toEqual(later);
  });

  it("skips a file that is gone by the time a snapshot reads it", async () => {
    const game = await project({ "src/game.ts": "one", "vite.config.ts.timestamp.mjs": "temporary" });
    const temporary = path.join(game.workspacePath, "vite.config.ts.timestamp.mjs");
    interception.before = async (operation, target) => {
      if (operation !== "lstat" || target !== temporary) return;
      interception.before = undefined;
      await rm(temporary);
    };
    const store = new CheckpointStore();
    const commit = await store.snapshot(game);
    expect(await store.read(game, commit, "vite.config.ts.timestamp.mjs")).toBeUndefined();
    expect(await store.read(game, commit, "src/game.ts")).toBeDefined();
  });

  it("refuses to replace a file that changed after the workspace was recorded", async () => {
    const game = await project({ "a.ts": "one", "b.ts": "one" });
    const file = (name: string) => path.join(game.workspacePath, name);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "a.ts": "two", "b.ts": "two" });
    const untouched = (await lstat(file("b.ts"))).ino;

    // Another writer saves a.ts right after the restore has recorded the workspace. The file keeps its size.
    interception.before = async (operation, target) => {
      if (operation !== "rename" || path.basename(target) !== "ohmygame-stat-cache.json") return;
      interception.before = undefined;
      await writeFile(file("a.ts"), "TWO");
    };
    const refused = await store.restore(game, before).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CheckpointChangedError);
    expect((refused as CheckpointChangedError).path).toBe("a.ts");
    expect(await contents(game.workspacePath)).toEqual({ "a.ts": "TWO", "b.ts": "two" });
    // The restore saw that before it changed anything.
    expect((await lstat(file("b.ts"))).ino).toBe(untouched);
    expect(await store.unfinished(game)).toBeUndefined();
  });

  it("refuses to go on when the workspace changes while it is being restored", async () => {
    const game = await project({ "a.ts": "one", "levels": "a file", "new.ts": "new" });
    const file = (name: string) => path.join(game.workspacePath, name);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    // To get back, the restore removes two files, replaces a.ts, and creates new.ts and levels, where an empty folder is now.
    const current = { "a.ts": "two", "extra.ts": "extra", "more.ts": "more1" };
    const prepare = async () => {
      await rm(game.workspacePath, { recursive: true });
      await mkdir(file("levels/world"), { recursive: true });
      await write(game.workspacePath, current);
    };
    // Another writer steps in when the restore removes its first file.
    const duringFirstRemoval = (act: (removed: string) => Promise<void>) => {
      interception.before = async (operation, target) => {
        if (operation !== "rm" || (target !== file("extra.ts") && target !== file("more.ts"))) return;
        interception.before = undefined;
        await act(path.basename(target));
      };
    };
    const refusedFor = async () => {
      const refused = await store.restore(game, before).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CheckpointChangedError);
      // What the restore had removed by then is back, and nothing says a restore is unfinished.
      expect(await store.unfinished(game)).toBeUndefined();
      return (refused as CheckpointChangedError).path;
    };

    await prepare();
    duringFirstRemoval(() => writeFile(file("a.ts"), "TWO"));
    expect(await refusedFor()).toBe("a.ts");
    expect(await contents(game.workspacePath)).toEqual({ ...current, "a.ts": "TWO" });

    await prepare();
    let other = "";
    duringFirstRemoval(async (removed) => {
      other = removed === "extra.ts" ? "more.ts" : "extra.ts";
      await writeFile(file(other), "saved");
    });
    expect(await refusedFor()).toBe(other);
    expect(await contents(game.workspacePath)).toEqual({ ...current, [other]: "saved" });

    await prepare();
    duringFirstRemoval(() => writeFile(file("new.ts"), "appeared meanwhile"));
    expect(await refusedFor()).toBe("new.ts");
    expect(await contents(game.workspacePath)).toEqual({ ...current, "new.ts": "appeared meanwhile" });

    await prepare();
    duringFirstRemoval(() => write(game.workspacePath, { "levels/world/node_modules/dep.js": "appeared meanwhile" }));
    await expect(store.restore(game, before)).rejects.toThrow();
    expect(await contents(game.workspacePath)).toEqual({ ...current, "levels/world/node_modules/dep.js": "appeared meanwhile" });

    await prepare();
    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual({ "a.ts": "one", "levels": "a file", "new.ts": "new" });
  });

  it("knows a file that was saved again by its content when its size and times do not tell", async () => {
    const game = await project({ "a.ts": "one" });
    const file = path.join(game.workspacePath, "a.ts");
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "a.ts": "two" });

    // The file is saved again right after the restore has recorded it, and looks no different for it.
    interception.before = async (operation, target) => {
      if (operation !== "rename" || path.basename(target) !== "ohmygame-stat-cache.json") return;
      interception.before = undefined;
      interception.frozen.set(file, await lstat(file));
      await writeFile(file, "TWO");
    };
    await expect(store.restore(game, before)).rejects.toBeInstanceOf(CheckpointChangedError);
    expect(await contents(game.workspacePath)).toEqual({ "a.ts": "TWO" });
  });

  it("does not replace a file that is saved while its old content is being written out", async () => {
    const game = await project({ "a.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "a.ts": "two" });

    // The old content is ready beside the file; another writer saves the file just before it would be replaced.
    interception.before = async (operation, target) => {
      if (operation !== "rename" || target !== path.join(game.workspacePath, "a.ts")) return;
      throw new Error("the file was replaced without a last look at it");
    };
    let looks = 0;
    const lastLook = interception.before;
    interception.before = async (operation, target) => {
      if (operation === "lstat" && target === path.join(game.workspacePath, "a.ts") && (await readdir(game.workspacePath)).some((name) => name.endsWith(".tmp"))) {
        looks += 1;
        if (looks === 1) await writeFile(target, "TWO");
      }
      await lastLook(operation, target);
    };
    await expect(store.restore(game, before)).rejects.toBeInstanceOf(CheckpointChangedError);
    interception.before = undefined;
    expect(await contents(game.workspacePath)).toEqual({ "a.ts": "TWO" });
  });

  it("says so when it cannot put back what a failed restore changed", async () => {
    const game = await project({ "kept.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    const current = { "kept.ts": "two", "added.ts": "added" };
    await write(game.workspacePath, current);

    // No file can be put in place any more, neither by the restore nor when it takes its changes back.
    interception.before = async (operation, target) => {
      if (operation === "rename" && target.startsWith(game.workspacePath)) throw new Error("disk failure");
    };
    const failed = await store.restore(game, before).catch((error: unknown) => error);
    interception.before = undefined;
    expect(failed).toBeInstanceOf(CheckpointIncompleteError);
    expect((failed as CheckpointIncompleteError).cause).toMatchObject({ message: "disk failure" });
    expect(await contents(game.workspacePath)).toEqual({ "kept.ts": "two" });

    // The snapshot it names is the workspace from before the restore, and the store remembers it, also after a restart.
    const previous = (failed as CheckpointIncompleteError).previous;
    expect(await new CheckpointStore().unfinished(game)).toBe(previous);
    await store.restore(game, previous);
    expect(await contents(game.workspacePath)).toEqual(current);
    expect(await store.unfinished(game)).toBeUndefined();
  });

  it("remembers a restore that is under way, and clears away what one that was cut off left behind", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two", "src/added.ts": "added" });

    let during: string | undefined;
    interception.before = async (operation, target) => {
      if (operation !== "rm" || target !== path.join(game.workspacePath, "src/added.ts")) return;
      interception.before = undefined;
      during = await store.unfinished(game);
    };
    const restored = await store.restore(game, before);
    expect(during).toBe(restored.previous);
    expect(await store.unfinished(game)).toBeUndefined();

    // A process that stops in the middle leaves its temporary files; the next snapshot removes them and records none.
    const left = { "src/.ohmygame-checkpoint-0f8b7c9e.tmp": "half of a file", ".ohmygame-checkpoint-1a2b3c4d.tmp": "half of a file" };
    await write(game.workspacePath, left);
    expect(await store.diff(game, before, await store.snapshot(game))).toEqual([]);
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one" });
  });

  it("does not write a damaged object into the workspace", async () => {
    const game = await project({ "src/game.ts": "one", "src/other.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    const current = { "src/game.ts": "two", "src/other.ts": "two" };
    await write(game.workspacePath, current);

    const oid = createHash("sha1").update("blob 3\0one").digest("hex");
    const object = path.join(checkpointDirectory(game), "objects", oid.slice(0, 2), oid.slice(2));
    // Once cut short, and once whole but with other content than its name stands for.
    for (const damaged of [(await readFile(object)).subarray(0, 6), deflateSync("blob 3\0two")]) {
      await writeFile(object, damaged);
      await expect(store.restore(game, before)).rejects.toThrow();
      expect(await contents(game.workspacePath)).toEqual(current);
      await expect(store.read(game, before, "src/game.ts")).rejects.toThrow();
    }
  });

  it("takes only checkpoint ids", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const commit = await store.snapshot(game);
    for (const id of ["", "HEAD", "../../config", commit.toUpperCase(), `${commit}/..`]) {
      await expect(store.diff(game, id, commit)).rejects.toThrow("Not a checkpoint id");
      await expect(store.restore(game, id)).rejects.toThrow("Not a checkpoint id");
    }
    // The id of a file's content is not the id of a snapshot.
    const blob = createHash("sha1").update("blob 3\0one").digest("hex");
    await expect(store.restore(game, blob)).rejects.toThrow("is not a commit");
    await expect(store.diff(game, commit, blob)).rejects.toThrow("is not a commit");
  });

  it("stores and restores files that are too large to hold in memory at once", async () => {
    const game = await project({ "src/game.ts": "one" });
    const asset = path.join(game.workspacePath, "assets/pack.bin");
    const original = Buffer.concat([randomBytes(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024, "a")]);
    await mkdir(path.dirname(asset));
    await writeFile(asset, original);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    expect(Buffer.from((await store.read(game, before, "assets/pack.bin"))!).equals(original)).toBe(true);

    await writeFile(asset, randomBytes(5 * 1024 * 1024));
    const after = await store.snapshot(game);
    expect(await store.diff(game, before, after)).toEqual([{ path: "assets/pack.bin", kind: "modified" }]);
    const undone = await store.undo(game, { before, after });
    expect((await readFile(asset)).equals(original)).toBe(true);

    // A damaged large object is not written into the workspace either.
    const replaced = await readFile(asset);
    const object = (content: Buffer) => {
      const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
      return path.join(checkpointDirectory(game), "objects", oid.slice(0, 2), oid.slice(2));
    };
    await store.restore(game, undone.previous);
    const current = await readFile(asset);
    await copyFile(object(current), object(replaced));
    await expect(store.restore(game, before)).rejects.toThrow("damaged");
    expect((await readFile(asset)).equals(current)).toBe(true);
    expect(await readdir(path.dirname(asset))).toEqual(["pack.bin"]);
  });

  it.skipIf(process.platform === "win32")("keeps the permissions of a file it replaces", async () => {
    const game = await project({ ".env": "KEY=one", "run.sh": "#!/bin/sh\n", "plain.txt": "one" });
    const mode = async (file: string) => (await lstat(path.join(game.workspacePath, file))).mode & 0o777;
    await chmod(path.join(game.workspacePath, ".env"), 0o600);
    await chmod(path.join(game.workspacePath, "run.sh"), 0o700);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { ".env": "KEY=two", "run.sh": "#!/bin/sh\nexit 1\n", "plain.txt": "two" });
    await chmod(path.join(game.workspacePath, "run.sh"), 0o600);
    await chmod(path.join(game.workspacePath, "plain.txt"), 0o755);

    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual({ ".env": "KEY=one", "run.sh": "#!/bin/sh\n", "plain.txt": "one" });
    expect([await mode(".env"), await mode("run.sh"), await mode("plain.txt")]).toEqual([0o600, 0o700, 0o644]);
  });

  it.skipIf(process.platform === "win32")("handles names that git and JavaScript objects treat specially", async () => {
    const files = Object.fromEntries([
      "a/x", "a-b", "a.txt", "a0", "__proto__", "constructor", "src/__proto__", "assets\\hero.png", "git~1", ".git.", ".gitignore", "notes/.gitx/y", "new\nline.txt", "emoji-🎮.txt", "n".repeat(255),
    ].map((file) => [file, `content of ${file}`]));
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    expect(await store.snapshot(game)).toBe(before);

    await write(game.workspacePath, Object.fromEntries(Object.keys(files).map((file) => [file, "changed"])));
    const after = await store.snapshot(game);
    expect((await store.diff(game, before, after)).map((change) => change.path)).toEqual(Object.keys(files).sort((left, right) => left < right ? -1 : 1));
    expect((await store.undo(game, { before, after })).changed).toHaveLength(Object.keys(files).length);
    expect(await contents(game.workspacePath)).toEqual(files);
  });

  it.skipIf(!hasGit || process.platform === "win32")("writes a store that git accepts", async () => {
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`src/module-${index % 12}/part-${index % 5}/file-${index}.ts`, `export const value = ${index};\n`]));
    const game = await project({ ...files, "a/x": "x", "a-b": "b", "a.txt": "t", "tools/build.sh": "#!/bin/sh\n", "empty.txt": "" });
    await chmod(path.join(game.workspacePath, "tools/build.sh"), 0o755);
    await symlink("src/module-0", path.join(game.workspacePath, "entry"));
    await writeFile(path.join(game.workspacePath, "pack.bin"), randomBytes(5 * 1024 * 1024));
    const store = new CheckpointStore();
    const first = await store.snapshot(game);
    await write(game.workspacePath, { "src/module-0/part-0/file-0.ts": "changed", "added.ts": "added" });
    const second = await store.snapshot(game);
    await store.restore(game, first);

    const git = (...parameters: string[]) => execFileSync("git", ["--git-dir", checkpointDirectory(game), ...parameters], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(git("fsck", "--strict", "--no-dangling")).toBe("");
    expect(git("rev-parse", "refs/heads/checkpoints").trim()).toBe(second);
    expect(git("rev-list", "--count", second).trim()).toBe("2");
    expect(git("diff", "--name-status", first, second).trim().split("\n")).toEqual(["A\tadded.ts", "M\tsrc/module-0/part-0/file-0.ts"]);
    expect(git("ls-tree", first, "entry", "tools/build.sh").trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["120000", "100755"]);
  });

  it("records again an object that no longer holds what a file is about to lose", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two" });
    await store.snapshot(game);

    // The object for the current content is damaged, as a power cut can leave it; only the file itself still has that content.
    const oid = createHash("sha1").update("blob 3\0two").digest("hex");
    const object = path.join(checkpointDirectory(game), "objects", oid.slice(0, 2), oid.slice(2));
    for (const damaged of [Buffer.alloc(0), deflateSync("blob 3\0xxx")]) {
      await writeFile(object, damaged);
      const restored = await store.restore(game, before);
      expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one" });
      await store.restore(game, restored.previous);
      expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two" });
    }
  });

  it("reads a file again when it changes while it is read", async () => {
    const game = await project({ "src/game.ts": "one" });
    const file = path.join(game.workspacePath, "src/game.ts");
    let looks = 0;
    interception.before = async (operation, target) => {
      if (operation !== "lstat" || target !== file) return;
      looks += 1;
      // The second look is the one after the content was read.
      if (looks === 2) await writeFile(file, "two");
    };
    const store = new CheckpointStore();
    const commit = await store.snapshot(game);
    interception.before = undefined;
    expect(Buffer.from((await store.read(game, commit, "src/game.ts"))!).toString("utf8")).toBe("two");
    expect(await store.snapshot(game)).toBe(commit);
  });

  it("fails a snapshot when a file cannot be read for a reason it does not know", async () => {
    const game = await project({ "src/game.ts": "one", "src/other.ts": "one" });
    interception.before = async (operation, target) => {
      if (operation === "lstat" && target === path.join(game.workspacePath, "src/other.ts")) throw Object.assign(new Error("input/output error"), { code: "EIO" });
    };
    await expect(new CheckpointStore().snapshot(game)).rejects.toThrow("input/output error");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves out a file it may not read, and never replaces it", async () => {
    const game = await project({ "src/game.ts": "one", "secret.key": "key" });
    const secret = path.join(game.workspacePath, "secret.key");
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two" });
    await chmod(secret, 0o000);
    try {
      const after = await store.snapshot(game);
      // The unreadable file is unknown, not a removal.
      expect(await store.diff(game, before, after)).toEqual([{ path: "src/game.ts", kind: "modified" }]);
      // The file is still there, so it is in the way of the one the snapshot holds.
      const refused = await store.restore(game, before).catch((error: unknown) => error);
      expect((refused as CheckpointConflictError).conflicts).toEqual(["secret.key"]);
      expect(await store.undo(game, { before, after }, { conflicts: "keep" })).toMatchObject({ changed: ["src/game.ts"], conflicts: [] });
    } finally {
      await chmod(secret, 0o600);
    }
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one", "secret.key": "key" });
  });

  it.skipIf(process.platform === "win32")("does not take an excluded file for one it removes when both are the same file", async () => {
    const game = await project({ "levels": "a file" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await rm(path.join(game.workspacePath, "levels"));
    await write(game.workspacePath, { "levels/one.json": "{}" });
    const after = await store.snapshot(game);
    await mkdir(path.join(game.workspacePath, "levels/node_modules"));
    await link(path.join(game.workspacePath, "levels/one.json"), path.join(game.workspacePath, "levels/node_modules/one.json"));
    const current = { "levels/one.json": "{}", "levels/node_modules/one.json": "{}" };

    const refused = await store.undo(game, { before, after }).catch((error: unknown) => error);
    expect((refused as CheckpointConflictError).conflicts).toEqual(["levels"]);
    expect(await contents(game.workspacePath)).toEqual(current);
  });

  it.skipIf(process.platform === "win32")("keeps a symbolic link whose target is not text", async () => {
    const game = await project({ "src/game.ts": "one" });
    const target = Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x2f, 0x78]);
    const entry = path.join(game.workspacePath, "entry");
    await symlink(target, entry);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await rm(entry);
    await store.restore(game, before);
    expect((await readlink(entry, { encoding: "buffer" })).equals(target)).toBe(true);
    expect(await store.diff(game, before, await store.snapshot(game))).toEqual([]);
  });

  it("stores as much of a large file as it was told to, and nothing when the file is shorter", async () => {
    const game = await project({});
    const gitdir = checkpointDirectory(game);
    const file = path.join(game.workspacePath, "pack.bin");
    const content = randomBytes(5 * 1024 * 1024 + 1);
    await writeFile(file, content);
    // A file that grew since its size was taken is stored up to that size, which makes a whole object.
    const size = 5 * 1024 * 1024;
    const oid = await writeFileBlob(gitdir, file, size);
    expect(oid).toBe(createHash("sha1").update(`blob ${size}\0`).update(content.subarray(0, size)).digest("hex"));
    // A file that shrank cannot give the object its header promises.
    await expect(writeFileBlob(gitdir, file, content.length + 1)).rejects.toBeInstanceOf(FileChangedError);
    expect((await readdir(gitdir, { recursive: true })).filter((name) => path.basename(name).startsWith("tmp_"))).toEqual([]);
  });
});

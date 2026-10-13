import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  BUFFERED_BYTES, DamagedObjectError, FileChangedError, SourceError, TREE_MODE, blobId, fileBlobId, fromSource, initialize, readCommitTree, readHead, readObject, readTree,
  removeObject, verifyBlob, writeAtomically, writeBlobTo, writeCommit, writeFileBlob, writeFileCopyBlob, writeHead, writeObject, writeTree, type TreeEntry,
} from "./checkpoint-objects.js";

type CheckpointProject = Pick<ProjectState, "workspacePath" | "storagePath">;

export interface CheckpointChange {
  /** Workspace path with forward slashes. */
  path: string;
  kind: "added" | "modified" | "removed";
}

export interface CheckpointRestoreResult {
  /** The workspace as it was just before, so `restore` can take the change back. */
  previous: string;
  /** Workspace paths that were written or removed, in path order. */
  changed: string[];
}

export interface CheckpointUndoResult extends CheckpointRestoreResult {
  /** Paths that could not simply be put back, in path order. See `CheckpointStore.undo`. */
  conflicts: string[];
}

/** Two snapshots that enclose the changes to undo, such as one Agent turn. */
export interface CheckpointRange {
  before: string;
  after: string;
}

export interface CheckpointUndoOptions {
  /** What to do with conflicts: leave those paths as they are, or put them back as well. Without it an undo with conflicts is refused. */
  conflicts?: "keep" | "overwrite";
}

/** A restore or an undo was refused because of these paths. The workspace was not touched. */
export class CheckpointConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`These files cannot be put back without losing later changes: ${conflicts.join(", ")}`);
  }
}

/**
 * Something else changed this file while a restore or an undo was under way.
 * The file was left as it is, what had already been changed was taken back,
 * and the operation can be tried again.
 */
export class CheckpointChangedError extends Error {
  constructor(readonly path: string) {
    super(`The workspace changed while a checkpoint was being put back: ${path}`);
  }
}

/** A restore or an undo failed part way and could not take back all it had changed. `previous` holds the workspace as it was before. */
export class CheckpointIncompleteError extends Error {
  constructor(readonly previous: string, cause: unknown) {
    super("The workspace is partly changed", { cause });
  }
}

interface FileEntry {
  oid: string;
  mode: string;
}

interface Change {
  path: string;
  /** The file on the side the diff starts from; absent when there is none. */
  from?: FileEntry;
  /** The file on the side the diff leads to; absent when there is none. */
  to?: FileEntry;
}

/** What tells that a file on disk is still the one that was read or written. */
interface FileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/**
 * A file as an operation read or wrote it. One that was changed a moment
 * before can change again without its size or times showing it, so such a
 * file is known again by its content.
 */
interface RecordedFile extends FileSignature {
  unsettled: boolean;
}

type Signatures = Map<string, RecordedFile>;
type StatCache = Map<string, FileSignature & FileEntry>;

interface Snapshot {
  commit: string;
  tree: string;
  /** Every file the snapshot holds, as the walk saw it. */
  seen: Signatures;
}

interface Walk {
  gitdir: string;
  workspace: string;
  started: number;
  cached: StatCache;
  settled: StatCache;
  seen: Signatures;
}

/** The changes an operation has made so far, and what each file it wrote looked like afterwards. */
interface Progress {
  made: Change[];
  written: Signatures;
}

const STAT_CACHE_FILE = "ohmygame-stat-cache.json";
const UNFINISHED_FILE = "ohmygame-unfinished.json";
const FILE_CONCURRENCY = 16;
const READ_ATTEMPTS = 3;
// A file changed this recently can change again without its size or times showing it: file systems keep times
// no finer than a few milliseconds on Linux and two seconds on FAT. The next snapshot reads it again instead of
// trusting the cache.
const UNSETTLED_MS = 2_000;
// Dependencies and version control are left out wherever they are. Build output and editor caches are left out at
// the workspace root only: a game may keep its own `levels/build/`. The rest of `.data/` is kept, unlike in the
// file tree and in published archives, because asset metadata must go back together with the assets it describes.
const EXCLUDED_ANYWHERE = new Set(["node_modules", ".git"]);
const EXCLUDED_AT_ROOT = new Set(["dist", "build", "out", ".ohmygame", ".ohmygame-install-pending", ".data/agent-attachments"]);
const TEMPORARY_PREFIX = ".ohmygame-checkpoint-";
const TEMPORARY_SUFFIX = ".tmp";
// A file that is gone by the time it is read, or that may not be read, is left out of a snapshot like an excluded one.
const UNREADABLE = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);

/** The git directory that holds a project's checkpoints. It is outside the workspace and is removed with the project. */
export function checkpointDirectory(project: CheckpointProject): string {
  return path.join(project.storagePath ?? path.dirname(project.workspacePath), "checkpoints");
}

function excluded(relativePath: string): boolean {
  if (EXCLUDED_AT_ROOT.has(relativePath)) return true;
  const name = path.posix.basename(relativePath);
  // Many file systems ignore case, and there `.Git` is the same folder as `.git`.
  return temporary(name) || EXCLUDED_ANYWHERE.has(name.toLowerCase());
}

/** Whether a name is one this store gives the files it writes before it renames them into place. */
function temporary(name: string): boolean {
  return name.startsWith(TEMPORARY_PREFIX) && name.endsWith(TEMPORARY_SUFFIX);
}

/**
 * Snapshots of a project's workspace in a git object store, so the changes
 * between two snapshots can be shown and undone. The store never uses the
 * workspace's own `.git` or `.gitignore`. Excluded paths are never recorded
 * and never touched.
 *
 * A restore or an undo replaces or removes a file only when a snapshot holds
 * it exactly as it is on disk, so what it overwrites can be had back. The
 * daemon must use one store: operations on a project run one at a time per
 * store.
 */
export class CheckpointStore {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #limit = limiter(FILE_CONCURRENCY);

  /** Records the workspace as it is now and returns the commit that holds it. */
  snapshot(project: CheckpointProject): Promise<string> {
    return this.#serialize(project, async () => (await this.#snapshot(project)).commit);
  }

  /** Lists the files that differ between two snapshots, in path order. */
  async diff(project: CheckpointProject, from: string, to: string): Promise<CheckpointChange[]> {
    const gitdir = checkpointDirectory(project);
    const changes = await this.#diff(gitdir, await readCommitTree(gitdir, from), await readCommitTree(gitdir, to));
    return changes
      .map((change): CheckpointChange => ({ path: change.path, kind: !change.from ? "added" : !change.to ? "removed" : "modified" }))
      .sort((left, right) => compare(left.path, right.path));
  }

  /**
   * Reads a file as a snapshot holds it, or the target of a symbolic link.
   * Undefined when the snapshot has no file there. The whole file is held in
   * memory, so this is for files a diff view would show.
   */
  async read(project: CheckpointProject, commit: string, filePath: string): Promise<Uint8Array | undefined> {
    const gitdir = checkpointDirectory(project);
    let tree = await readCommitTree(gitdir, commit);
    const names = filePath.split("/");
    for (const [index, name] of names.entries()) {
      const entry = (await this.#entries(gitdir, tree)).get(name);
      if (index === names.length - 1) return entry && entry.mode !== TREE_MODE ? await readObject(gitdir, entry.oid, "blob") : undefined;
      if (entry?.mode !== TREE_MODE) return undefined;
      tree = entry.oid;
    }
    return undefined;
  }

  /**
   * The snapshot from before a restore or an undo that never came to an end,
   * for example because the app quit, and so may have left the workspace
   * partly changed. Restoring it puts the workspace back as it was. Undefined
   * when the last restore or undo ran to its end.
   */
  async unfinished(project: CheckpointProject): Promise<string | undefined> {
    try {
      const { previous } = JSON.parse(await readFile(path.join(checkpointDirectory(project), UNFINISHED_FILE), "utf8")) as { previous?: unknown };
      return typeof previous === "string" ? previous : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Puts the whole workspace back to a snapshot. Only files that differ are
   * written or removed. It is refused, with nothing touched, when a file
   * cannot come back because something that is not part of checkpoints, such
   * as a folder of excluded files, is in its place.
   */
  restore(project: CheckpointProject, commit: string): Promise<CheckpointRestoreResult> {
    return this.#serialize(project, async () => {
      const gitdir = checkpointDirectory(project);
      const target = await readCommitTree(gitdir, commit);
      const { current, changes } = await this.#planned(project, async (snapshot) => ({ changes: await this.#diff(gitdir, snapshot.tree, target) }));
      const blocked = await this.#blocked(project, current, changes);
      if (blocked.length) throw new CheckpointConflictError(blocked);
      await this.#apply(project, current, changes);
      return { previous: current.commit, changed: paths(changes) };
    });
  }

  /**
   * Takes back the changes between two snapshots and leaves everything else
   * as it is now. A file that is already back as it was is left alone.
   *
   * A file is a conflict when it was changed again afterwards, or when it
   * cannot come back because something that appeared afterwards is in its
   * place. With conflicts the undo is refused, with nothing touched, unless
   * the caller says to keep those files as they are or to overwrite them.
   * Files that are not part of checkpoints are never removed, so a file they
   * block is refused even then.
   */
  undo(project: CheckpointProject, range: CheckpointRange, options: CheckpointUndoOptions = {}): Promise<CheckpointUndoResult> {
    return this.#serialize(project, async () => {
      const gitdir = checkpointDirectory(project);
      const [before, after] = await Promise.all([readCommitTree(gitdir, range.before), readCommitTree(gitdir, range.after)]);
      const { current, changes, changedAgain } = await this.#planned(project, (snapshot) => this.#undoing(gitdir, before, after, snapshot.tree, options.conflicts === "overwrite"));
      const blocked = await this.#blocked(project, current, changes);
      const conflicts = [...new Set([...changedAgain, ...blocked])].sort(compare);
      if (conflicts.length && !options.conflicts) throw new CheckpointConflictError(conflicts);
      if (blocked.length && options.conflicts === "overwrite") throw new CheckpointConflictError(blocked);
      const applied = changes.filter((change) => !blocked.includes(change.path));
      await this.#apply(project, current, applied);
      return { previous: current.commit, changed: paths(applied), conflicts };
    });
  }

  /** Works out from the trees alone what an undo changes and which files were changed again after the range. */
  async #undoing(gitdir: string, before: string, after: string, current: string, overwrite: boolean): Promise<{ changes: Change[]; changedAgain: string[] }> {
    const [ranged, since, back] = await Promise.all([this.#diff(gitdir, before, after), this.#diff(gitdir, after, current), this.#diff(gitdir, current, before)]);
    const inRange = new Set(paths(ranged));
    const edited = new Set(paths(since));
    // What it takes to bring the files of the range back; files that are already back are not in it.
    const wanted = back.filter((change) => inRange.has(change.path));

    // A file cannot be written while another file is where one of its folders must be, or below where it must be.
    const present = new Map(back.filter((change) => change.from).map((change) => [change.path, change]));
    const below = new Map<string, Change[]>();
    for (const change of present.values()) {
      for (const folder of parents(change.path)) {
        const files = below.get(folder);
        if (files) files.push(change);
        else below.set(folder, [change]);
      }
    }
    const obstacles = (change: Change): Change[] => change.to
      ? [...parents(change.path).flatMap((folder) => present.get(folder) ?? []), ...below.get(change.path) ?? []]
      : [];

    // An obstacle that the range itself left there goes away with the undo; one that appeared or changed later stays.
    const changedAgain = wanted
      .filter((change) => edited.has(change.path) || obstacles(change).some((obstacle) => edited.has(obstacle.path)))
      .map((change) => change.path);
    const changes = new Map(wanted.filter((change) => overwrite || !changedAgain.includes(change.path)).map((change) => [change.path, change]));
    // Overwriting a conflict also clears what is in the way of the file that comes back.
    for (const change of [...changes.values()]) {
      for (const obstacle of obstacles(change)) changes.set(obstacle.path, obstacle);
    }
    return { changes: [...changes.values()], changedAgain };
  }

  /**
   * Records the workspace and plans changes against that record. What makes
   * a change safe is that the store holds the content it replaces, so every
   * such object is read through first. A damaged one is thrown away and the
   * workspace is recorded once more, which stores it anew from the file.
   */
  async #planned<T extends { changes: Change[] }>(project: CheckpointProject, plan: (current: Snapshot) => Promise<T>): Promise<T & { current: Snapshot }> {
    const gitdir = checkpointDirectory(project);
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.#snapshot(project);
      const planned = await plan(current);
      const replaced = [...new Set(planned.changes.flatMap((change) => change.from ? [change.from.oid] : []))];
      const damaged = (await all(replaced.map((oid) => this.#limit(() => verifyBlob(gitdir, oid).then(() => undefined, (error: unknown) => {
        if (error instanceof DamagedObjectError) return oid;
        throw error;
      }))))).filter((oid) => oid !== undefined);
      if (damaged.length === 0) return { ...planned, current };
      if (attempt === 2) throw new DamagedObjectError(damaged[0]!);
      await Promise.all(damaged.map((oid) => removeObject(gitdir, oid)));
      await rm(path.join(gitdir, STAT_CACHE_FILE), { force: true });
    }
  }

  /**
   * Looks at the workspace before anything in it is changed. Throws when a
   * file to replace or remove is no longer what the snapshot holds. Returns
   * the files that cannot be created because something these changes do not
   * remove is in their place: a file whose name differs only in case on a
   * file system that ignores case, or a folder with excluded files.
   */
  async #blocked(project: CheckpointProject, current: Snapshot, changes: Change[]): Promise<string[]> {
    const workspace = project.workspacePath;
    const removing = new Set<string>();
    await all(changes.map(async (change) => change.from && await this.#limit(async () => {
      const stats = await this.#recorded(project, current.seen, change);
      if (!change.to) removing.add(identity(stats));
    })));

    const places = new Map<string, Promise<"free" | "folder" | "taken">>();
    const place = (relative: string): Promise<"free" | "folder" | "taken"> => {
      let found = places.get(relative);
      if (!found) {
        found = this.#limit(async () => {
          const stats = await lstat(path.join(workspace, relative)).catch(() => undefined);
          if (!stats) return "free";
          if (stats.isDirectory()) return "folder";
          return removing.has(identity(stats)) ? "free" : "taken";
        });
        places.set(relative, found);
      }
      return found;
    };
    const blocked: string[] = [];
    await all(changes.map(async (change) => {
      if (change.from || !change.to) return;
      for (const folder of parents(change.path)) {
        const found = await place(folder);
        if (found === "taken") blocked.push(change.path);
        if (found !== "folder") return;
      }
      const found = await place(change.path);
      if (found === "taken" || (found === "folder" && !(await holdsOnly(workspace, change.path, removing)))) blocked.push(change.path);
    }));
    return blocked.sort(compare);
  }

  /** Returns the stats of a file that is to be replaced or removed, and throws when it is not the file that was recorded. */
  async #recorded(project: CheckpointProject, recorded: Signatures, change: Change): Promise<Stats> {
    const file = path.join(project.workspacePath, change.path);
    const stats = await lstat(file).catch(() => undefined);
    const signature = recorded.get(change.path);
    if (!stats || !signature || stats.isDirectory() || !sameFile(signature, stats) || signature.ino !== stats.ino) throw new CheckpointChangedError(change.path);
    if (signature.unsettled) {
      const oid = await (stats.isSymbolicLink() ? readlink(file, { encoding: "buffer" }).then(blobId) : fileBlobId(file, stats.size)).catch(() => undefined);
      if (oid !== change.from!.oid) throw new CheckpointChangedError(change.path);
    }
    return stats;
  }

  /** Makes the changes. When that fails part way, the ones already made are taken back. */
  async #apply(project: CheckpointProject, current: Snapshot, changes: Change[]): Promise<void> {
    const gitdir = checkpointDirectory(project);
    const unfinished = path.join(gitdir, UNFINISHED_FILE);
    if (changes.length === 0) return await rm(unfinished, { force: true });
    // Says, until the end is reached, where to go back to if this process does not get there.
    await writeAtomically(gitdir, unfinished, JSON.stringify({ previous: current.commit }));
    const progress: Progress = { made: [], written: new Map() };
    try {
      await this.#make(project, changes, current.seen, progress, false);
    } catch (cause) {
      // The content to return to is already in the store, so this needs no room for a new snapshot.
      const inverse = progress.made.map((change): Change => ({ path: change.path, ...(change.to ? { from: change.to } : {}), ...(change.from ? { to: change.from } : {}) }));
      await this.#make(project, inverse, progress.written, { made: [], written: new Map() }, true).catch(() => { throw new CheckpointIncompleteError(current.commit, cause); });
      await rm(unfinished, { force: true });
      throw cause;
    }
    await rm(unfinished, { force: true });
  }

  /**
   * Writes and removes workspace files as the changes say and notes each one
   * it makes. A file is replaced or removed only while it is still what
   * `recorded` says. Taking changes back goes on after a failure, to put
   * back as much as can be.
   */
  async #make(project: CheckpointProject, changes: Change[], recorded: Signatures, progress: Progress, goOn: boolean): Promise<void> {
    const workspace = project.workspacePath;
    const failures: unknown[] = [];
    // Removals go first so a file can take the place of a folder and the other way round.
    for (const change of changes) {
      if (change.to || (failures.length && !goOn)) continue;
      try {
        await this.#recorded(project, recorded, change);
        await rm(path.join(workspace, change.path), { force: true });
        progress.made.push(change);
        await removeEmptyDirectories(workspace, path.posix.dirname(change.path));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length && !goOn) throw failures[0];
    // Nothing is still writing when the changes made are taken back: `all` waits for every write.
    await all(changes.map(async (change) => change.to && await this.#limit(async () => {
      progress.written.set(change.path, await this.#place(project, change, recorded));
      progress.made.push(change);
    }))).catch((error: unknown) => { failures.push(error); });
    if (failures.length) throw failures[0];
  }

  /**
   * Puts one file in place and returns what it looks like there. The content
   * goes to a temporary file beside it first, so a failure never leaves half
   * a file.
   */
  async #place(project: CheckpointProject, change: Change, recorded: Signatures): Promise<RecordedFile> {
    const gitdir = checkpointDirectory(project);
    const entry = change.to!;
    const file = path.join(project.workspacePath, change.path);
    const replaced = change.from ? await this.#recorded(project, recorded, change) : undefined;
    await mkdir(path.dirname(file), { recursive: true });
    // The temporary name does not build on the file's own name, which may already be as long as a name can be.
    const beside = path.join(path.dirname(file), `${TEMPORARY_PREFIX}${randomUUID()}${TEMPORARY_SUFFIX}`);
    try {
      if (entry.mode === "120000") await symlink(await readObject(gitdir, entry.oid, "blob"), beside);
      else {
        // A file has the permissions of the one it replaces from the start; only whether it can be executed comes from the snapshot.
        const kept = replaced?.isFile() ? replaced.mode & 0o777 : undefined;
        await writeBlobTo(gitdir, entry.oid, beside, kept);
        const mode = kept ?? (await lstat(beside)).mode & 0o777;
        await chmod(beside, entry.mode === "100755" ? mode | ((mode & 0o444) >> 2) : mode & ~0o111);
      }
      // Writing the content took time, so the place is looked at once more just before it is taken.
      if (change.from) await this.#recorded(project, recorded, change);
      else {
        const existing = await lstat(file).catch(() => undefined);
        if (existing?.isDirectory()) await removeEmptyTree(file);
        else if (existing) throw new CheckpointChangedError(change.path);
      }
      await rename(beside, file);
      return { ...signatureOf(await lstat(file)), unsettled: true };
    } catch (error) {
      await rm(beside, { force: true });
      await removeEmptyDirectories(project.workspacePath, path.posix.dirname(change.path));
      throw error;
    }
  }

  async #snapshot(project: CheckpointProject): Promise<Snapshot> {
    const gitdir = checkpointDirectory(project);
    await initialize(gitdir);
    const walk: Walk = { gitdir, workspace: project.workspacePath, started: Date.now(), cached: await readStatCache(gitdir), settled: new Map(), seen: new Map() };
    const tree = await this.#writeDirectory(walk, "") ?? await writeTree(gitdir, []);
    // The cache is only there for speed, so a failure to write it is not a failure of the snapshot.
    await writeAtomically(gitdir, path.join(gitdir, STAT_CACHE_FILE), JSON.stringify(Object.fromEntries(walk.settled))).catch(() => {});
    const head = await readHead(gitdir);
    const headTree = head && await readCommitTree(gitdir, head).catch(() => undefined);
    if (head && headTree === tree) return { commit: head, tree, seen: walk.seen };
    const commit = await writeCommit(gitdir, tree, headTree ? head : undefined);
    await writeHead(gitdir, commit);
    return { commit, tree, seen: walk.seen };
  }

  /** Writes one folder as a tree and returns its id, or undefined when nothing in it is kept. */
  async #writeDirectory(walk: Walk, relative: string): Promise<string | undefined> {
    const names = await this.#limit(() => fromSource(readdir(path.join(walk.workspace, relative))));
    const entries = (await all(names.map(async (name): Promise<TreeEntry | undefined> => {
      const entryPath = relative ? `${relative}/${name}` : name;
      if (excluded(entryPath)) {
        // What a restore that was cut off left behind. No restore is under way now: operations run one at a time.
        if (temporary(name)) await rm(path.join(walk.workspace, entryPath), { force: true }).catch(() => {});
        return undefined;
      }
      try {
        const file = await this.#limit(async () => {
          const stats = await fromSource(lstat(path.join(walk.workspace, entryPath)));
          if (stats.isDirectory()) return "folder" as const;
          return stats.isFile() || stats.isSymbolicLink() ? await this.#writeFile(walk, entryPath, stats) : undefined;
        });
        if (file !== "folder") return file && { ...file, name };
        const oid = await this.#writeDirectory(walk, entryPath);
        return oid ? { mode: TREE_MODE, name, oid } : undefined;
      } catch (error) {
        // The workspace is in use: something listed a moment ago, such as a build tool's temporary file, can be gone by now.
        if (error instanceof SourceError && UNREADABLE.has(error.code ?? "")) return undefined;
        throw error;
      }
    }))).filter((entry) => entry !== undefined);
    return entries.length ? await this.#limit(() => writeTree(walk.gitdir, entries)) : undefined;
  }

  /** Stores one file or symbolic link and returns its tree entry. A file that changes while it is read is read again. */
  async #writeFile(walk: Walk, entryPath: string, first: Stats): Promise<FileEntry> {
    const absolute = path.join(walk.workspace, entryPath);
    for (let stats = first, attempt = 1; ; attempt += 1) {
      const mode = stats.isSymbolicLink() ? "120000" : stats.mode & 0o111 ? "100755" : "100644";
      const cached = walk.cached.get(entryPath);
      let oid = cached && cached.mode === mode && sameFile(cached, stats) ? cached.oid : undefined;
      if (!oid) {
        try {
          oid = stats.isSymbolicLink()
            ? await writeObject(walk.gitdir, "blob", await fromSource(readlink(absolute, { encoding: "buffer" })))
            : await writeFileBlob(walk.gitdir, absolute, stats.size);
        } catch (error) {
          if (!(error instanceof FileChangedError)) throw error;
          // After the last attempt a file that does not hold still is recorded from a copy of it.
          if (attempt === READ_ATTEMPTS) oid = await writeFileCopyBlob(walk.gitdir, absolute);
        }
        const after = await fromSource(lstat(absolute));
        // On file systems with coarse timestamps an in-place rewrite of the same size
        // can have identical stat signatures. Rehash recently changed small files.
        // Large files already undergo a two-pass write and hash verification.
        const unsettled = Math.max(stats.mtimeMs, stats.ctimeMs) > walk.started - UNSETTLED_MS;
        const changedContent = oid && unsettled && after.isFile() && after.size <= BUFFERED_BYTES
          ? await fileBlobId(absolute, after.size).then((current) => current !== oid)
          : false;
        const changed = !oid || (stats.size <= BUFFERED_BYTES && !sameFile(stats, after)) || changedContent;
        if (attempt < READ_ATTEMPTS && changed) {
          stats = after;
          continue;
        }
      }
      const signature = signatureOf(stats);
      const unsettled = Math.max(stats.mtimeMs, stats.ctimeMs) > walk.started - UNSETTLED_MS;
      walk.seen.set(entryPath, { ...signature, unsettled });
      if (!unsettled) walk.settled.set(entryPath, { ...signature, mode, oid: oid! });
      return { mode, oid: oid! };
    }
  }

  /** Collects the files that differ between two trees. Subtrees with the same id are skipped whole. */
  async #diff(gitdir: string, from: string | undefined, to: string | undefined, prefix = "", changes: Change[] = []): Promise<Change[]> {
    if (from === to) return changes;
    const [before, after] = await Promise.all([this.#entries(gitdir, from), this.#entries(gitdir, to)]);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(name);
      const right = after.get(name);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (left?.oid === right?.oid && left?.mode === right?.mode) continue;
      const leftTree = left?.mode === TREE_MODE ? left.oid : undefined;
      const rightTree = right?.mode === TREE_MODE ? right.oid : undefined;
      if (leftTree || rightTree) await this.#diff(gitdir, leftTree, rightTree, entryPath, changes);
      const leftFile = left && !leftTree ? { oid: left.oid, mode: left.mode } : undefined;
      const rightFile = right && !rightTree ? { oid: right.oid, mode: right.mode } : undefined;
      if (leftFile || rightFile) changes.push({ path: entryPath, ...(leftFile ? { from: leftFile } : {}), ...(rightFile ? { to: rightFile } : {}) });
    }
    return changes;
  }

  async #entries(gitdir: string, tree: string | undefined): Promise<Map<string, TreeEntry>> {
    if (!tree) return new Map();
    return new Map((await readTree(gitdir, tree)).map((entry) => [entry.name, entry]));
  }

  /** Snapshots and changes of one project run one at a time: two conversations may work in it at once. */
  #serialize<T>(project: CheckpointProject, operation: () => Promise<T>): Promise<T> {
    const key = checkpointDirectory(project);
    const result = (this.#queues.get(key) ?? Promise.resolve()).then(operation, operation);
    const settled = result.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => { if (this.#queues.get(key) === settled) this.#queues.delete(key); });
    return result;
  }
}

/** Waits for every operation, also after one failed, so that nothing is still running when the failure is reported. */
async function all<T>(operations: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(operations);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function paths(changes: Change[]): string[] {
  return changes.map((change) => change.path).sort(compare);
}

/** The folders a path is in, from the top down. */
function parents(filePath: string): string[] {
  const names = filePath.split("/");
  return names.slice(1).map((_, index) => names.slice(0, index + 1).join("/"));
}

function signatureOf(stats: Stats): FileSignature {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino };
}

/** Size and times decide alone whether the cache is trusted: file ids are not kept across mounts on every file system. */
function sameFile(recorded: FileSignature, stats: FileSignature): boolean {
  return recorded.size === stats.size && recorded.mtimeMs === stats.mtimeMs && recorded.ctimeMs === stats.ctimeMs;
}

function identity(stats: { dev: number; ino: number }): string {
  return `${stats.dev}:${stats.ino}`;
}

/** Whether a folder holds nothing but folders and files that are about to be removed. */
async function holdsOnly(workspace: string, relative: string, removing: ReadonlySet<string>): Promise<boolean> {
  for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
    const entryPath = `${relative}/${entry.name}`;
    // An excluded file is never removed, also when it is one and the same file as one that is.
    if (excluded(entryPath)) return false;
    if (entry.isDirectory() ? !(await holdsOnly(workspace, entryPath, removing)) : !removing.has(identity(await lstat(path.join(workspace, entryPath))))) return false;
  }
  return true;
}

/** Removes a folder that holds nothing but empty folders. It fails, and removes no file, when there is a file in it. */
async function removeEmptyTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyTree(path.join(directory, entry.name));
  }
  await rmdir(directory);
}

/** Removes folders a change emptied, from the given one up to the workspace root. */
async function removeEmptyDirectories(workspace: string, relative: string): Promise<void> {
  for (let current = relative; current && current !== "."; current = path.posix.dirname(current)) {
    try {
      await rmdir(path.join(workspace, current));
    } catch {
      return;
    }
  }
}

async function readStatCache(gitdir: string): Promise<StatCache> {
  try {
    return new Map(Object.entries(JSON.parse(await readFile(path.join(gitdir, STAT_CACHE_FILE), "utf8")) as Record<string, FileSignature & FileEntry>));
  } catch {
    // Without the cache every file is read again, which is only slower.
    return new Map();
  }
}

/** Runs at most `limit` operations at a time, however deeply the calls that start them are nested. */
function limiter(limit: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (operation) => {
    // A finished operation hands its place straight to the next one waiting.
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

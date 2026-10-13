import type { ProjectState } from "../shared/contracts.js";
import { listProjectCheckpoints, restoreProjectCheckpoint, undoProjectCheckpoint } from "./api.js";

/**
 * Native dialogs keep the existing Projects and studio layout unchanged.
 * Never restore anything without a separate, explicit user confirmation.
 */
export async function restoreCheckpointFromProjectMenu(project: ProjectState): Promise<boolean> {
  const history = await listProjectCheckpoints(project.id);
  if (history.unfinished) {
    if (!window.confirm("An earlier restore was interrupted. Recover the exact workspace state captured before that operation? Close any external editors first. The current partial state will be preserved as a recovery checkpoint.")) return false;
    const result = await restoreProjectCheckpoint(project.id, history.unfinished);
    window.alert(`Interrupted restore recovered. ${result.changed.length} file(s) updated. Reopen the project before editing.`);
    return true;
  }
  const turns = history.turns.slice(0, 20);
  if (!turns.length && !history.recoveries.length) {
    window.alert("No game recovery points yet. A recovery point is created before the next Agent run.");
    return false;
  }
  const choices = turns.map((turn, index) => {
    const when = new Date(turn.finishedAt ?? turn.startedAt).toLocaleString();
    const names = (turn.changes ?? []).slice(0, 3).map((change) => change.path).join(", ");
    const more = (turn.changes?.length ?? 0) > 3 ? ", …" : "";
    return `${index + 1}. ${when} — ${turn.changes?.length ?? "?"} files: ${names}${more}`;
  });
  const recoveries = history.recoveries.slice(-3).reverse();
  const recoveriesText = recoveries.map((_, index) => `p${index + 1}: Undo an earlier recovery`);
  const selection = window.prompt(
    `Restore project "${project.name}"\n\n${choices.join("\n")}\n${recoveriesText.join("\n")}\n\nEnter a number to undo that Agent turn, r<number> to restore the version before it, or p<number> to recover a previous state. No game files change until you confirm.`,
    turns.length ? (turns[0]?.after ? "1" : "r1") : "p1",
  );
  if (selection === null) return false;
  const chosen = /^(r|p)?([1-9][0-9]*)$/i.exec(selection.trim());
  if (!chosen) throw new Error("Choose a listed recovery point number.");
  const index = Number(chosen[2]) - 1;
  const mode = chosen[1]?.toLowerCase();
  const turn = turns[index];
  const recovery = recoveries[index];
  if (mode === "p" ? !recovery : !turn || (!mode && !turn.after)) {
    throw new Error("The selected recovery point is unavailable.");
  }
  const action = mode === "p" ? "recover the previous workspace" : mode === "r" ? "restore an earlier workspace version" : "undo the selected Agent turn";
  if (!window.confirm(`Are you sure you want to ${action}?\n\nGame files may be replaced or removed. Close other windows editing this project first. A checkpoint of the current workspace will be retained so you can reverse this change.`)) {
    return false;
  }
  const result = mode === "p"
    ? await restoreProjectCheckpoint(project.id, recovery!)
    : mode === "r"
      ? await restoreProjectCheckpoint(project.id, turn!.before)
      : await undoProjectCheckpoint(project.id, turn!.turnId);
  window.alert(`Workspace recovery completed. ${result.changed.length} file(s) updated. Reopen the project to refresh its editor.`);
  return true;
}

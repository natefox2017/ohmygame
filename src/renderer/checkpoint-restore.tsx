import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, X } from "./icons.js";
import { t } from "./i18n.js";
import type { ProjectState } from "../shared/contracts.js";
import {
  listProjectCheckpoints,
  restoreProjectCheckpoint,
  undoProjectCheckpoint,
  type ProjectCheckpointHistory,
} from "./api.js";

type RestoreChoice = { id: string; title: string; details: string; kind: "undo" | "restore"; value: string };

function checkpointChoices(history: ProjectCheckpointHistory): RestoreChoice[] {
  if (history.unfinished) {
    return [{ id: "interrupted", title: t("checkpointRestore.interrupted"), details: t("checkpointRestore.interruptedHint"), kind: "restore", value: history.unfinished }];
  }
  const turns = history.turns.flatMap((turn) => {
    const time = new Date(turn.finishedAt ?? turn.startedAt).toLocaleString();
    const files = turn.changes ?? [];
    const details = files.length
      ? t("checkpointRestore.files", { count: files.length, paths: `${files.slice(0, 4).map((file) => file.path).join(", ")}${files.length > 4 ? ", …" : ""}` })
      : t("checkpointRestore.noChanges");
    return [
      ...(turn.after ? [{ id: `undo:${turn.turnId}`, title: t("checkpointRestore.undo", { time }), details, kind: "undo" as const, value: turn.turnId }] : []),
      { id: `before:${turn.turnId}`, title: t("checkpointRestore.before", { time }), details, kind: "restore" as const, value: turn.before },
    ];
  });
  const recoveries = [...history.recoveries].slice(-3).reverse().map((commit, index) => ({
    id: `recovery:${commit}`, title: t("checkpointRestore.revert", { index: index + 1 }),
    details: t("checkpointRestore.revertHint"),
    kind: "restore" as const, value: commit,
  }));
  return [...turns, ...recoveries];
}

/** An on-demand overlay using the existing project modal; no page layout changes. */
export function ProjectCheckpointDialog({ project, onClose, onRecovered }: {
  project: ProjectState;
  onClose: () => void;
  onRecovered: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [history, setHistory] = useState<ProjectCheckpointHistory>();
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    void listProjectCheckpoints(project.id).then((value) => {
      if (active) { setHistory(value); setLoading(false); }
    }).catch((cause) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
    });
    return () => { active = false; previous?.focus(); };
  }, [project.id]);

  useEffect(() => {
    if (saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const choices = history ? checkpointChoices(history) : [];
  const selected = choices.find((item) => item.id === selectedId);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selected || saving) return;
    if (!confirming) { setConfirming(true); return; }
    setSaving(true);
    setError(undefined);
    try {
      if (selected.kind === "undo") await undoProjectCheckpoint(project.id, selected.value);
      else await restoreProjectCheckpoint(project.id, selected.value);
      onRecovered();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfirming(false);
      setSaving(false);
    }
  }

  return (
    <div className="project-create-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section ref={dialog} className="project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{t("checkpointRestore.title", { name: project.name })}</h2>
          <button type="button" disabled={saving} onClick={onClose} aria-label={t("checkpointRestore.close")}><X size={16} /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          {loading ? <p role="status"><LoaderCircle size={14} className="spin" /> {t("checkpointRestore.loading")}</p> : null}
          {!loading && !choices.length ? <p>{t("checkpointRestore.empty")}</p> : null}
          {choices.length > 0 ? (
            <fieldset className="project-create-types" style={{ maxHeight: "min(48vh, 360px)", overflowY: "auto", display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
              <legend>{t("checkpointRestore.savedVersions")}</legend>
              {choices.map((choice) => (
                <button key={choice.id} type="button" disabled={saving} aria-pressed={choice.id === selectedId}
                  className={choice.id === selectedId ? "is-active" : undefined}
                  onClick={() => { setSelectedId(choice.id); setConfirming(false); setError(undefined); }}
                  style={{ textAlign: "left", display: "block", width: "100%" }}>
                  <strong>{choice.title}</strong>
                  <span style={{ display: "block", marginTop: 4, fontSize: 12, wordBreak: "break-word" }}>{choice.details}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {confirming ? (
            <p role="alert">{t("checkpointRestore.confirmWarning")}</p>
          ) : null}
          {error ? <p className="project-create-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={saving} onClick={onClose}>{t("checkpointRestore.cancel")}</button>
            <button className="project-create-submit" type="submit" disabled={!selected || saving}>
              {saving ? <LoaderCircle className="spin" size={14} /> : null}
              {confirming ? t("checkpointRestore.confirm") : t("checkpointRestore.continue")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

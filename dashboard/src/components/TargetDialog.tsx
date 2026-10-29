import { useEffect, useState } from "react";
import { Help, HelpPortalTarget } from "../help/Help";
import type { useTargetControl } from "../hooks/useTargetControl";
import { ago } from "../lib/format";

export function TargetDialog({
  editor,
  enabled,
  names = false,
}: {
  editor: ReturnType<typeof useTargetControl>;
  enabled: boolean;
  names?: boolean;
}) {
  const [openedAt] = useState(() => Date.now() / 1000);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const { form, busy } = editor;
  useEffect(() => {
    if (!dialog) return;
    dialog.showModal();
    dialog
      .querySelector<HTMLInputElement>(names ? "#target-input" : "#target-id")
      ?.focus();
    return () => {
      dialog.close();
    };
  }, [dialog, names]);
  useEffect(() => {
    if (form.candidates.length)
      dialog?.querySelector<HTMLSelectElement>("#target-pid")?.focus();
  }, [dialog, form.candidates]);
  const key = String(form.generation);
  return (
    <dialog
      ref={setDialog}
      id="target-settings"
      className="target-dialog"
      aria-labelledby="target-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        editor.close();
      }}
      onClose={() => {
        if (form.open) editor.close();
      }}
    >
      <HelpPortalTarget value={dialog}>
        <Help key={key + "title"} topic="manage-targets" as="div">
          <h2 id="target-dialog-title">Add target</h2>
          <p className="muted">
            {names
              ? "Monitor every process with this exact Linux name. Linux keeps 15 bytes of a name. The local sampler configuration owns production selection."
              : "Monitor one more process with the local sampler. A process name follows a restart; a PID does not."}{" "}
            The change applies to every viewer.
          </p>
        </Help>
        <form
          id="target-form"
          className="target-form"
          onSubmit={(event) => {
            event.preventDefault();
            editor.add();
          }}
        >
          {!names && (
            <Help key={key + "id"} topic="target-id">
              <label htmlFor="target-id">Target ID</label>
              <input
                id="target-id"
                maxLength={31}
                pattern="[A-Za-z0-9_.\-]+"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. orders"
                disabled={busy}
                value={form.id}
                onChange={(event) => {
                  editor.edit("id", event.currentTarget.value);
                }}
              />
            </Help>
          )}
          <Help key={key + "process"} topic="manage-targets">
            <label htmlFor="target-input">
              {names ? "Exact process name" : "Process name or PID"}
            </label>
            <input
              id="target-input"
              name="target"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder={names ? "e.g. orders-api" : "e.g. ghostty or 1234"}
              disabled={busy}
              value={form.target}
              onChange={(event) => {
                editor.edit("target", event.currentTarget.value);
              }}
            />
          </Help>
          {form.candidates.length > 0 && (
            <Help
              key={key + "candidates"}
              topic="target-pid"
              id="target-candidates"
            >
              <label htmlFor="target-pid">Matching processes</label>
              <select
                id="target-pid"
                disabled={busy}
                value=""
                onChange={(event) => {
                  editor.select(event.currentTarget.value);
                  dialog
                    ?.querySelector<HTMLButtonElement>("#target-save")
                    ?.focus();
                }}
              >
                <option value="">
                  Select one of {form.candidates.length} listed
                </option>
                {form.candidates.map((item) => (
                  <option key={item.pid} value={item.pid}>
                    {[
                      `PID ${String(item.pid)}`,
                      item.user,
                      item.started_at === null
                        ? ""
                        : "started " + ago(openedAt - item.started_at),
                      item.command,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
            </Help>
          )}
          <Help
            key={key + "actions"}
            topic="manage-targets"
            as="div"
            className="dialog-actions"
          >
            <button id="target-cancel" type="button" onClick={editor.close}>
              Cancel
            </button>
            <button
              id="target-save"
              className="primary"
              type="submit"
              disabled={busy || !enabled}
            >
              Add target
            </button>
          </Help>
        </form>
        <Help key={key + "status"} topic="manage-targets" as="div">
          <p
            id="target-status"
            role="status"
            className={form.bad ? "bad" : "muted"}
          >
            {form.status}
          </p>
        </Help>
      </HelpPortalTarget>
    </dialog>
  );
}

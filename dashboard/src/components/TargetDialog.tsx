import { useEffect, useState } from "react";
import { Help, HelpPortalTarget } from "../help/Help";
import type { useTargetControl } from "../hooks/useTargetControl";

export function TargetDialog({
  editor,
  enabled,
}: {
  editor: ReturnType<typeof useTargetControl>;
  enabled: boolean;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const { form, busy } = editor;
  useEffect(() => {
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("#target-input")?.focus();
    return () => {
      dialog.close();
    };
  }, [dialog]);
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
            Monitor every process with this exact Linux name. Linux keeps 15
            bytes of a name. The local sampler configuration owns production
            selection. The change applies to every viewer.
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
          <Help key={key + "process"} topic="manage-targets">
            <label htmlFor="target-input">Exact process name</label>
            <input
              id="target-input"
              name="target"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. orders-api"
              disabled={busy}
              value={form.target}
              onChange={(event) => {
                editor.edit(event.currentTarget.value);
              }}
            />
          </Help>
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

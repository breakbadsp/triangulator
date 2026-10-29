import { useEffect, useReducer, useRef, useState } from "react";
import {
  changeTargets,
  type ProcessCandidate,
  type TargetChange,
  type TargetControl,
} from "../api/targetControl";

type Form = {
  id: string;
  target: string;
  candidates: ProcessCandidate[];
  status: string;
  bad: boolean;
  open: boolean;
  generation: number;
};
type Event =
  | { type: "open"; error: string }
  | { type: "close" }
  | { type: "edit"; field: "id" | "target"; value: string }
  | {
      type: "status";
      message: string;
      bad?: boolean;
      candidates?: ProcessCandidate[];
    }
  | { type: "done"; message: string; close: boolean };
const initial: Form = {
  id: "",
  target: "",
  candidates: [],
  status: "",
  bad: false,
  open: false,
  generation: 0,
};
function reduce(state: Form, event: Event): Form {
  switch (event.type) {
    case "open":
      return {
        ...initial,
        open: true,
        generation: state.generation + 1,
        status: event.error,
        bad: !!event.error,
      };
    case "close":
      return {
        ...state,
        open: false,
        generation: state.generation + 1,
        candidates: [],
        status: "",
        bad: false,
      };
    case "edit":
      return { ...state, [event.field]: event.value, candidates: [] };
    case "status":
      return {
        ...state,
        status: event.message,
        bad: event.bad ?? false,
        candidates: event.candidates ?? [],
      };
    case "done":
      return {
        ...state,
        id: "",
        target: "",
        candidates: [],
        status: event.message,
        bad: false,
        open: event.close ? false : state.open,
      };
  }
}

/** The question before a change, which applies to every viewer. */
function confirmation(change: TargetChange) {
  const scope = "This changes monitoring for every viewer.";
  if (change.action === "remove")
    return "rule" in change
      ? `Remove the process name ${change.rule}? Every process named ${change.rule} stops being monitored. ${scope}`
      : `Remove ${change.id}? ${scope}`;
  if ("id" in change) return `Add ${change.id}? ${scope}`;
  return `Add the process name ${change.target}? Every process with this name is monitored. ${scope}`;
}

export function useTargetControl(control: TargetControl, refresh: () => void) {
  const [form, dispatch] = useReducer(reduce, initial);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const context = useRef({ control, generation: 0, mounted: true });
  useEffect(() => {
    context.current.control = control;
  }, [control]);
  useEffect(() => {
    const state = context.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
    };
  }, []);
  function close() {
    ++context.current.generation;
    dispatch({ type: "close" });
  }
  async function change(change: TargetChange) {
    if (inFlight.current) return;
    const start = context.current;
    const host = control.enabled ? control.host : "";
    const generation = start.generation;
    const current = () =>
      context.current.mounted && context.current.generation === generation;
    if (!control.enabled) {
      dispatch({
        type: "status",
        message: "Target control unavailable",
        bad: true,
      });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (change.action === "add") {
        dispatch({ type: "status", message: "Checking…" });
        const checked = await changeTargets(change, true);
        if (!current()) return;
        if (checked.kind === "failed") {
          reject(checked);
          return;
        }
      }
      if (!current()) return;
      const latest = context.current.control;
      if (!latest.enabled || latest.host !== host) {
        dispatch({
          type: "status",
          message: "Target control changed. Reload the target list and retry.",
          bad: true,
        });
        return;
      }
      if (!confirm(confirmation(change))) {
        dispatch({ type: "status", message: "" });
        return;
      }
      dispatch({ type: "status", message: "Applying…" });
      const result = await changeTargets(change);
      if (result.kind === "done") refresh();
      if (!current()) {
        if (result.kind === "failed" && result.applied) refresh();
        return;
      }
      if (result.kind === "failed") reject(result);
      else
        dispatch({
          type: "done",
          message: result.message,
          close: change.action === "add",
        });
    } finally {
      inFlight.current = false;
      if (context.current.mounted) setBusy(false);
    }
    function reject(
      result: Extract<
        Awaited<ReturnType<typeof changeTargets>>,
        { kind: "failed" }
      >,
    ) {
      const candidates = change.action === "add" ? result.candidates : [];
      const name = change.action === "add" ? change.target : "";
      dispatch({
        type: "status",
        bad: true,
        candidates,
        message: candidates.length
          ? `${String(result.total)} processes are named ${name}${result.total > candidates.length ? `; the first ${String(candidates.length)} are listed` : ""}. Select one to monitor it by PID.`
          : result.message,
      });
      if (result.applied) refresh();
    }
  }
  function add() {
    if (inFlight.current) return;
    const id = form.id.trim(),
      target = form.target.trim();
    if (control.enabled && control.mode === "names") {
      if (!/^[A-Za-z0-9_.-]{1,15}$/.test(target) || /^\.\.?$/.test(target)) {
        dispatch({
          type: "status",
          message:
            "Enter an exact process name of 1 to 15 letters, digits, dots, underscores, or hyphens.",
          bad: true,
        });
        return;
      }
      void change({ action: "add", target });
      return;
    }
    if (
      !/^[A-Za-z0-9_.-]{1,31}$/.test(id) ||
      id === "." ||
      id === ".." ||
      !target
    ) {
      dispatch({
        type: "status",
        message: "Enter a valid target ID and process name or PID.",
        bad: true,
      });
      return;
    }
    void change({ action: "add", id, target });
  }
  return {
    form,
    busy,
    add,
    close,
    change,
    open() {
      if (!control.enabled || inFlight.current) return;
      ++context.current.generation;
      dispatch({ type: "open", error: control.error });
    },
    edit(field: "id" | "target", value: string) {
      dispatch({ type: "edit", field, value });
    },
    select(pid: string) {
      if (!pid) return;
      dispatch({ type: "edit", field: "target", value: pid });
      dispatch({
        type: "status",
        message: `PID ${pid} selected. A PID does not follow a restart. Select Add target.`,
      });
    },
  };
}

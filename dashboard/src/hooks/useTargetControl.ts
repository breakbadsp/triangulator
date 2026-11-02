import { useEffect, useReducer, useRef, useState } from "react";
import {
  changeTargets,
  type TargetChange,
  type TargetControl,
} from "../api/targetControl";

type Form = {
  target: string;
  status: string;
  bad: boolean;
  open: boolean;
  generation: number;
};
type Event =
  | { type: "open"; error: string }
  | { type: "close" }
  | { type: "edit"; value: string }
  | { type: "status"; message: string; bad?: boolean }
  | { type: "done"; message: string; close: boolean };
const initial: Form = {
  target: "",
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
        status: "",
        bad: false,
      };
    case "edit":
      return { ...state, target: event.value };
    case "status":
      return {
        ...state,
        status: event.message,
        bad: event.bad ?? false,
      };
    case "done":
      return {
        ...state,
        target: "",
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
    return `Remove the process name ${change.rule}? Every process named ${change.rule} stops being monitored. ${scope}`;
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
      dispatch({ type: "status", bad: true, message: result.message });
      if (result.applied) refresh();
    }
  }
  function add() {
    if (inFlight.current) return;
    const target = form.target.trim();
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
    edit(value: string) {
      dispatch({ type: "edit", value });
    },
  };
}

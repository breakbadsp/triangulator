import { GuideContext } from "../help/guideContext";
import { ObservationContext } from "./observationContext";
import {
  useContext,
  useEffect,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";

/**
 * Whether the pointer is over a surface or the focus is in it. React sends
 * enter and leave through portals, so the surface's help card counts as part
 * of it.
 */
export function useHolding() {
  const guide = useContext(GuideContext);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const [pointer, setPointer] = useState(false);
  // Removing a portal under the pointer (Escape or Close help) can omit
  // mouseleave. The next move must release the snapshot outside its owner.
  useEffect(() => {
    if (!pointer) return;
    function move(event: globalThis.MouseEvent) {
      const panel = surface;
      const target = event.target;
      if (!panel || !(target instanceof Element) || panel.contains(target))
        return;
      const card = target.closest(".help-card[id]");
      if (
        card &&
        [...panel.querySelectorAll("[aria-describedby]")].some(
          (anchor) => anchor.getAttribute("aria-describedby") === card.id,
        )
      )
        return;
      setPointer(false);
    }
    document.addEventListener("mousemove", move);
    return () => {
      document.removeEventListener("mousemove", move);
    };
  }, [pointer, surface]);
  const [focus, setFocus] = useState(false);
  return {
    holding:
      pointer ||
      focus ||
      !!(surface && guide?.request?.ancestors.includes(surface)),
    handlers: {
      onMouseEnter: (event: MouseEvent<HTMLElement>) => {
        setSurface(event.currentTarget);
        setPointer(true);
      },
      onMouseLeave: () => {
        setPointer(false);
      },
      onFocus: (event: FocusEvent<HTMLElement>) => {
        setSurface(event.currentTarget);
        setFocus(true);
      },
      onBlur: (event: FocusEvent) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setFocus(false);
      },
    },
  };
}

/**
 * The value as it was when `holding` became true, until it becomes false.
 * A live panel renders from this, so a poll cannot move what is under the
 * pointer (the old page skipped those redraws).
 */
export function useHeld<T>(value: T, holding: boolean): T {
  const { key } = useContext(ObservationContext);
  const [held, setHeld] = useState<{ value: T; key: string } | null>(null);
  if (holding && (!held || held.key !== key)) setHeld({ value, key });
  if (!holding && held) setHeld(null);
  return holding && held?.key === key ? held.value : value;
}

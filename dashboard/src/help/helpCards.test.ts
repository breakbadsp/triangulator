import { describe, expect, it, vi } from "vitest";
import { createHelpCards } from "./helpCards";

function card(active: boolean) {
  return { active: active ? {} : null, cancel: vi.fn() };
}

describe("Help cards of a page", () => {
  it("Escape closes only the cards of the page that has an open card", () => {
    const page = createHelpCards();
    const other = createHelpCards();
    const open = card(true);
    const idle = card(false);
    const elsewhere = card(false);
    page.add(open);
    page.add(idle);
    other.add(elsewhere);
    const stopPage = page.listen();
    const stopOther = other.listen();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(open.cancel).toHaveBeenCalledWith(true);
    expect(idle.cancel).toHaveBeenCalledWith(true);
    expect(elsewhere.cancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    stopPage();
    stopOther();
  });

  it("leaves Escape alone when no card is open or pending", () => {
    const page = createHelpCards();
    const remove = page.add(card(false));
    const stop = page.listen();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    remove();
    stop();
  });
});

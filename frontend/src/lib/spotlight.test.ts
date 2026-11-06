import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findByLabel, spotlight } from "./spotlight";

function sized(el: HTMLElement) {
  el.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, width: 80, height: 30, right: 90, bottom: 40, toJSON: () => ({}) });
  return el;
}

describe("spotlight", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it("finds a control by its visible label or aria-label, ignoring a leading +", () => {
    document.body.innerHTML = '<button>+ Add Deal</button><button aria-label="New record">Create</button><a href="#">All Contacts (12)</a>';
    document.querySelectorAll<HTMLElement>("button, a").forEach(sized);
    expect(findByLabel("Add Deal")?.textContent).toBe("+ Add Deal");
    expect(findByLabel("New record")?.textContent).toBe("Create");
    expect(findByLabel("All Contacts")?.textContent).toBe("All Contacts (12)");
    expect(findByLabel("Delete everything")).toBeNull();
  });

  it("ignores hidden controls and those inside dialogs", () => {
    document.body.innerHTML = '<button>Save</button><div role="dialog"><button>Save</button></div>';
    expect(findByLabel("Save")).toBeNull(); // the visible-size check fails for the first, the dialog for the second
  });

  it("highlights the control once it renders, then removes the highlight", () => {
    vi.useFakeTimers();
    spotlight("New pipeline", { durationMs: 1000 });
    document.body.appendChild(sized(Object.assign(document.createElement("button"), { textContent: "New pipeline" })));
    vi.advanceTimersByTime(200);
    expect(document.getElementById("kl-spotlight")).not.toBeNull();
    vi.advanceTimersByTime(1100);
    expect(document.getElementById("kl-spotlight")).toBeNull();
  });
});

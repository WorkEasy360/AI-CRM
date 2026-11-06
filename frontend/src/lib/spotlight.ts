/**
 * "Take me there" spotlight: after navigating to an article's page, find the button the article names
 * and pulse a highlight around it for a few seconds.
 *
 * Matching is by the label a person sees (or its aria-label), exactly as the article writes it, so no
 * screen needs special markup. If nothing matches — the button is behind a permission, or the page
 * changed — it simply does nothing.
 */

const CANDIDATES = 'button, a, [role="tab"], [role="menuitem"], [role="button"], summary, label';
const OVERLAY_ID = "kl-spotlight";

function normalise(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

export function findByLabel(label: string, root: ParentNode = document): HTMLElement | null {
  const wanted = normalise(label.replace(/^\+\s*/, ""));
  if (!wanted) return null;
  let prefix: HTMLElement | null = null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES))) {
    if (el.closest(`#${OVERLAY_ID}, [role="dialog"]`)) continue;
    const text = normalise(el.getAttribute("aria-label")) || normalise(el.textContent).replace(/^\+\s*/, "");
    if (!text || !visible(el)) continue;
    if (text === wanted) return el;
    // "All Contacts (12)" still matches "All Contacts".
    if (!prefix && text.startsWith(wanted) && /^[\s(:·-]/.test(text.slice(wanted.length) || " ")) prefix = el;
  }
  return prefix;
}

function highlight(el: HTMLElement, durationMs: number) {
  document.getElementById(OVERLAY_ID)?.remove();
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("aria-hidden", "true");
  overlay.className = "kl-spotlight";
  const tip = document.createElement("span");
  tip.className = "kl-spotlight-tip";
  tip.textContent = "Start here";
  overlay.appendChild(tip);
  document.body.appendChild(overlay);
  const place = () => {
    const rect = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      top: `${rect.top - 6}px`,
      left: `${rect.left - 6}px`,
      width: `${rect.width + 12}px`,
      height: `${rect.height + 12}px`,
    });
  };
  place();
  const timer = window.setInterval(place, 100);
  window.setTimeout(() => {
    window.clearInterval(timer);
    overlay.remove();
  }, durationMs);
}

/** Wait (up to ``timeoutMs``) for the page to render the labelled control, then highlight it. */
export function spotlight(label: string, { timeoutMs = 4000, durationMs = 4500 } = {}): void {
  if (typeof window === "undefined" || !label) return;
  const started = Date.now();
  const tick = () => {
    const el = findByLabel(label);
    if (el) {
      highlight(el, durationMs);
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tick, 150);
  };
  window.setTimeout(tick, 150);
}

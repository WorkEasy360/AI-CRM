"use client";

import * as React from "react";

/**
 * Windowing for long scrolling lists (Kanban columns, the Sheet grid): only the items inside the
 * viewport, plus `overscan` on each side, are rendered; spacers stand in for the rest so the
 * scrollbar keeps its true length. With a fixed `itemHeight` the window is exact; with a typical
 * height it is close enough for variable cards (the spacers absorb the difference).
 */
export function useWindowedList({
  count,
  itemHeight,
  overscan = 6,
  enabled = true,
}: {
  count: number;
  itemHeight: number;
  overscan?: number;
  enabled?: boolean;
}) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [height, setHeight] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollTop(el.scrollTop));
    };
    const measure = () => setHeight(el.clientHeight);
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [enabled]);

  if (!enabled) {
    return { ref, start: 0, end: count, padTop: 0, padBottom: 0, scrollTop };
  }
  // Before the first measurement (and in jsdom) render a first screenful rather than nothing.
  const viewport = height || itemHeight * 20;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / itemHeight) + overscan);
  return {
    ref,
    start,
    end,
    padTop: start * itemHeight,
    padBottom: Math.max(0, (count - end) * itemHeight),
    scrollTop,
  };
}

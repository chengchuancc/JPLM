import { useEffect } from "react";

/** Fit each table to the visible space below its toolbar, including tables in dialogs. */
export function useTableViewport() {
  useEffect(() => {
    let frame = 0;
    let stopped = false;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(schedule);

    function update() {
      frame = 0;
      const viewport = window.visualViewport;
      const screenBottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
      const tables = [...document.querySelectorAll<HTMLElement>(".table-wrap")];
      const targets = new Set<Element>([document.body]);
      for (const wrap of tables) {
        if (!wrap.querySelector(":scope > table")) continue;
        targets.add(wrap);
        if (wrap.parentElement) targets.add(wrap.parentElement);
        const dialog = wrap.closest<HTMLElement>(".dialog");
        if (dialog) targets.add(dialog);
        const top = wrap.getBoundingClientRect().top;
        const available = Math.max(Math.min(160, screenBottom - 64), dialog
          // A centered dialog moves as its table grows. Use its content budget rather than
          // its current bottom edge, so measuring the new height cannot move the header.
          ? (viewport?.height || window.innerHeight) - 56 - (dialog.scrollHeight - wrap.offsetHeight)
          : screenBottom - Math.max(top, 16) - 24);
        const value = Math.floor(available) + "px";
        if (wrap.style.getPropertyValue("--table-available-height") !== value) {
          wrap.style.setProperty("--table-available-height", value);
        }
      }
      for (const target of observed) {
        if (!targets.has(target)) { resize.unobserve(target); observed.delete(target); }
      }
      for (const target of targets) {
        if (!observed.has(target)) { resize.observe(target); observed.add(target); }
      }
    }
    function schedule() {
      if (!stopped && !frame) frame = window.requestAnimationFrame(update);
    }
    function scroll(event: Event) {
      // Scrolling the data itself does not change the table's position on screen.
      if (event.target instanceof Element && event.target.classList.contains("table-wrap")) return;
      schedule();
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("scroll", scroll, true);
    schedule();
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
}

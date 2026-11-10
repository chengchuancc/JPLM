import { useEffect, type RefObject } from "react";

export function useShipmentRowLocation(grid: RefObject<HTMLDivElement | null>, id: string, ready: boolean) {
  useEffect(() => {
    const container = grid.current;
    if (!container || !id || !ready) return;
    const locate = () => {
      const row = container.querySelector<HTMLElement>('[data-shipment-id="' + CSS.escape(id) + '"]');
      if (!row) return false;
      const viewport = container.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      container.scrollTop += bounds.top - viewport.top - (viewport.height - bounds.height) / 2;
      return true;
    };
    if (locate()) return;
    const observer = new MutationObserver(() => { if (locate()) observer.disconnect(); });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [grid, id, ready]);
}

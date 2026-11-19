import { useEffect, useId, useImperativeHandle, useRef, useState, type ComponentPropsWithRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "./table-scroll.css";

export function TableScroll({ ref, id, className, children, ...props }: ComponentPropsWithRef<"div">) {
  const viewport = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const [position, setPosition] = useState({ left: 0, max: 0 });
  useImperativeHandle(ref, () => viewport.current!, []);
  const viewportId = id ?? generatedId;

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => {
      const max = Math.max(0, node.scrollWidth - node.clientWidth);
      const left = Math.max(0, Math.min(max, Math.round(node.scrollLeft)));
      setPosition((previous) => previous.left === left && previous.max === max ? previous : { left, max });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    let table: HTMLTableElement | null = null;
    const watchTable = () => {
      const next = node.querySelector<HTMLTableElement>(":scope > table");
      if (next !== table) {
        if (table) resize.unobserve(table);
        if (next) resize.observe(next);
        table = next;
      }
      measure();
    };
    const changes = new MutationObserver(watchTable);
    changes.observe(node, { childList: true });
    watchTable();
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      node.removeEventListener("scroll", measure);
      resize.disconnect();
      changes.disconnect();
    };
  }, []);

  function move(direction: number) {
    const node = viewport.current;
    if (node) node.scrollLeft += direction * Math.round(node.clientWidth * 0.6);
  }

  return <div className="table-frame">
    {position.max > 1 && <div className="table-horizontal" role="group" aria-label="横向浏览表格">
      <button type="button" className="icon-btn" title="向左翻列" aria-label="向左翻列"
        disabled={position.left <= 0} aria-controls={viewportId} onClick={() => move(-1)}>
        <ChevronLeft size={16} />
      </button>
      <input type="range" aria-label="表格横向位置" aria-controls={viewportId}
        min={0} max={position.max} value={position.left}
        onChange={(event) => {
          if (!viewport.current) return;
          viewport.current.scrollLeft = event.currentTarget.valueAsNumber;
          setPosition({ ...position, left: Math.round(viewport.current.scrollLeft) });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }} />
      <button type="button" className="icon-btn" title="向右翻列" aria-label="向右翻列"
        disabled={position.left >= position.max - 1} aria-controls={viewportId} onClick={() => move(1)}>
        <ChevronRight size={16} />
      </button>
    </div>}
    <div {...props} id={viewportId} ref={viewport} className={className ? "table-wrap " + className : "table-wrap"}>
      {children}
    </div>
  </div>;
}

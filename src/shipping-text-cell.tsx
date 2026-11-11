import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Copy } from "lucide-react";

export function ShippingTextCell({ value, label }: { value: string | number | undefined; label: string }) {
  const content = String(value ?? "").trim();
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const [notice, setNotice] = useState("");
  const open = !!position;

  useEffect(() => {
    if (!open) return;
    copyButton.current?.focus({ preventScroll: true });
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !popup.current?.contains(event.target))
        setPosition(undefined);
    };
    const dismissOnScroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.current?.contains(event.target))) setPosition(undefined);
    };
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismissOnScroll);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismissOnScroll);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setPosition(undefined);
      return;
    }
    const cell = anchor.current?.closest("td")?.getBoundingClientRect();
    if (!cell) return;
    const width = Math.min(520, window.innerWidth - 16);
    const left = Math.max(8, Math.min(cell.left, window.innerWidth - width - 8));
    setNotice("");
    setPosition({
      width, left,
      ...(cell.top > window.innerHeight / 2
        ? { bottom: Math.max(8, window.innerHeight - cell.bottom) }
        : { top: Math.max(8, cell.top) }),
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setNotice("已复制");
    } catch {
      const selection = window.getSelection();
      if (text.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(text.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setNotice("请手动复制" + label);
    }
  }

  if (!content) return <span>—</span>;
  return <>
    <button ref={anchor} type="button" className="shipping-text-trigger" title={"展开" + label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
      {content}
    </button>
    {position && createPortal(<div ref={popup} id={id} role="dialog" aria-label={"完整" + label}
      className="shipping-text-popup" style={position} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setPosition(undefined);
        anchor.current?.focus({ preventScroll: true });
      }}>
      <p ref={text}>{content}</p>
      <div className="shipping-text-actions">
        <span role="status">{notice}</span>
        <button ref={copyButton} type="button" className="btn small" onClick={() => void copy()}>
          <Copy size={14} />复制{label}
        </button>
      </div>
    </div>, document.body)}
  </>;
}

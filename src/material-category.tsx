import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus } from "lucide-react";

export function MaterialCategory({ label, value, options, disabled, autoOpen, onChange, onDismiss }: {
  label: string; value: string; options: string[]; disabled?: boolean; autoOpen?: boolean;
  onChange: (value: string) => void; onDismiss?: () => void;
}) {
  const [position, setPosition] = useState<CSSProperties>();
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const open = !!position;
  const term = query.trim();
  const normalize = (name: string) => name.normalize("NFKC").toLowerCase();
  const names = [...new Set([...options, value].filter(Boolean))];
  const matches = names.filter((name) => normalize(name).includes(normalize(term)));
  const exact = names.find((name) => normalize(name) === normalize(term));
  function locate() {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(Math.max(anchor.width, 205), window.innerWidth - 16);
    const above = window.innerHeight - anchor.bottom < 245 && anchor.top > 245;
    setPosition({ width, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      ...(above ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }) });
  }
  function dismiss() {
    setPosition(undefined);
    onDismiss?.();
  }
  function select(name: string) {
    setPosition(undefined);
    onChange(name);
    trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => { if (autoOpen) locate(); }, [autoOpen]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) dismiss();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.current?.contains(event.target))) locate();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", locate);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", locate);
    };
  }, [open]);
  return <>
    <button ref={trigger} className="material-category-trigger" type="button" aria-label={label}
      aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => { if (open) dismiss(); else { setQuery(""); locate(); } }}>
      <span>{value || "选择类别"}</span><ChevronDown size={14} />
    </button>
    {open && createPortal(<div className="material-category-popup" ref={popup} id={id} style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); trigger.current?.focus(); }
    }}>
      <input ref={input} aria-label="搜索或新增物料类别" placeholder="搜索或新增类别" maxLength={64}
        value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault(); if (term) select(exact || term);
          }
        }} />
      <div className="material-category-options">{matches.map((name) => <button key={name} type="button"
        aria-pressed={name === value} onClick={() => select(name)}>
        <span>{name}</span>{name === value && <Check size={14} />}
      </button>)}</div>
      {term && !exact && <button className="btn small" type="button" onClick={() => select(term)}>
        <Plus size={14} />新增「{term}」
      </button>}
    </div>, document.body)}
  </>;
}

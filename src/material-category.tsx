import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus } from "lucide-react";
import { materialCategoryTone, OptionTag, type OptionTone } from "./option-tag";

type PickerProps = {
  label: string; value: string; options: string[]; disabled?: boolean; autoOpen?: boolean;
  onChange: (value: string) => void; onDismiss?: () => void;
};
type Choice = { value: string; label: string; tone?: OptionTone };

export function MaterialCategory({ options, ...props }: PickerProps) {
  const choices = [...new Set([...options, props.value].filter(Boolean))].map((value) => ({
    value, label: value, tone: materialCategoryTone(value, options),
  }));
  return <TableOptionPicker {...props} choices={choices} allowNew />;
}

export function TableOptionPicker({ label, value, choices, disabled, autoOpen, onChange, onDismiss, allowNew,
  searchLabel = "搜索或新增物料类别", searchPlaceholder = "搜索或新增类别" }:
  Omit<PickerProps, "options"> & { choices: Choice[]; allowNew?: boolean; searchLabel?: string; searchPlaceholder?: string }) {
  const [position, setPosition] = useState<CSSProperties>();
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const open = !!position;
  const term = query.trim();
  const normalize = (name: string) => name.normalize("NFKC").toLowerCase();
  const selected = choices.find((choice) => choice.value === value);
  const matches = choices.filter((choice) => normalize(choice.label).includes(normalize(term)));
  const exact = choices.find((choice) => normalize(choice.label) === normalize(term));
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
    (input.current || popup.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ||
      popup.current?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
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
      {selected ? <OptionTag label={selected.label} tone={selected.tone} /> : <span>{allowNew ? "选择类别" : label}</span>}
      <ChevronDown size={14} />
    </button>
    {open && createPortal(<div className="material-category-popup" ref={popup} id={id} style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); trigger.current?.focus(); }
      if (event.key === "Tab") { dismiss(); trigger.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".material-category-options button:not(:disabled)")];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
        if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
      }
    }}>
      {allowNew && <input ref={input} aria-label={searchLabel} placeholder={searchPlaceholder} maxLength={64}
        value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault(); if (term) select(exact?.value || term);
          }
        }} />}
      <div className="material-category-options">{matches.map((choice) => <button key={choice.value} type="button"
        disabled={disabled} aria-pressed={choice.value === value} onClick={() => select(choice.value)}>
        <OptionTag label={choice.label} tone={choice.tone} />{choice.value === value && <Check size={14} />}
      </button>)}</div>
      {allowNew && term && !exact && <button className="btn small" type="button" onClick={() => select(term)}>
        <Plus size={14} />新增「{term}」
      </button>}
    </div>, document.body)}
  </>;
}

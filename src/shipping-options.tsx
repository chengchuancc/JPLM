import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus } from "lucide-react";
import { CarrierTag, CarrierTags, SourceTag, carrierNames, path, sources, type Request } from "./shipping-data";
import { countryOption, countryOptions } from "./shipping-countries";

export function ShippingPicker({ kind, request, value, disabled, onChange, autoOpen, onDismiss }: {
  kind: "carriers" | "sources" | "country"; request: Request; value?: string | number;
  disabled: boolean; onChange: (value: string) => void; autoOpen?: boolean; onDismiss?: () => void;
}) {
  const [position, setPosition] = useState<CSSProperties>();
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const opened = position !== undefined;
  const multiple = kind === "carriers";
  const country = kind === "country";
  const label = multiple ? "承运商" : country ? "国家 / 地区" : "来源";
  const searchLabel = (country ? "搜索" : "搜索或新增") + label;
  const current = String(value ?? "");
  const selected = multiple ? carrierNames(value) : current ? [current] : [];
  const entered = search.trim();
  const normalize = (name: string) => name.toLowerCase();
  const catalog = country ? countryOptions : multiple ? options : [...sources, ...options];
  const names = [...new Map([...catalog, ...selected].map((name) => [normalize(name), name])).values()];
  const available = names.filter((name) => {
    const match = country ? countryOption(name) : undefined;
    return normalize([name, match?.label, match?.code].filter(Boolean).join(" ")).includes(normalize(entered));
  });
  const canAdd = !country && !!entered && (!multiple || !entered.includes("、")) &&
    !names.some((name) => normalize(name) === normalize(entered));

  function dismiss() {
    setPosition(undefined);
    onDismiss?.();
  }

  function locate() {
    const rect = anchor.current!.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    const above = window.innerHeight - rect.bottom < 220 && rect.top > 220;
    return {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
      ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    };
  }

  useEffect(() => {
    if (!opened) return;
    let active = true;
    searchInput.current?.focus({ preventScroll: true });
    if (!country) request(path + kind).then((result) => { if (active) setOptions(result); },
      (failure) => { if (active) setError(failure.message); });
    const clickOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !popup.current?.contains(event.target))
        dismiss();
    };
    const reposition = (event: Event) => {
      if (anchor.current && !(event.target instanceof Node && popup.current?.contains(event.target))) setPosition(locate());
    };
    document.addEventListener("pointerdown", clickOutside);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", clickOutside);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [opened]);

  useEffect(() => {
    if (autoOpen) setPosition(locate());
  }, [autoOpen]);

  function toggle() {
    if (position) { dismiss(); return; }
    setSearch("");
    setError("");
    setPosition(locate());
  }

  function choose(name: string) {
    if (!multiple) {
      onChange(name);
      setPosition(undefined);
      anchor.current?.focus({ preventScroll: true });
      return;
    }
    const exists = selected.some((item) => normalize(item) === normalize(name));
    onChange((exists ? selected.filter((item) => normalize(item) !== normalize(name)) : [...selected, name]).join("、"));
  }
  function add() {
    if (!canAdd) return;
    choose(entered);
    setOptions((previous) => [...previous, entered]);
    setSearch("");
  }
  return <>
    <button ref={anchor} className="shipping-carrier-trigger" type="button" aria-label={"选择" + label}
      aria-expanded={!!position} aria-controls={position ? panelId : undefined} disabled={disabled} onClick={toggle}>
      {selected.length ? (multiple ? <CarrierTags value={value} /> : country ? <span>{current}</span> : <SourceTag value={current} />)
        : <span className="muted">选择{label}</span>}
      <ChevronDown size={14} />
    </button>
    {position && createPortal(<div id={panelId} ref={popup} className="shipping-carrier-menu" style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); dismiss(); anchor.current?.focus(); }
      }}>
      <input ref={searchInput} aria-label={searchLabel} placeholder={searchLabel} maxLength={100} value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canAdd) add();
            else if (!multiple && available.length === 1) choose(available[0]);
          }
        }} />
      <div className="shipping-carrier-options">
        {!multiple && current && !entered && <button type="button" onClick={() => choose("")}>清空</button>}
        {available.map((name) => multiple ? <label key={name}>
          <input type="checkbox" checked={selected.some((item) => normalize(item) === normalize(name))}
            onChange={() => choose(name)} />
          <CarrierTag name={name} />
        </label> : <button type="button" key={name} aria-pressed={normalize(name) === normalize(current)} onClick={() => choose(name)}>
          {country ? <><span>{countryOption(name)?.label || name}</span>{countryOption(name) && <small>{name}</small>}</>
            : <SourceTag value={name} />}
        </button>)}
        {!available.length && !canAdd && <span className="muted">没有匹配的{label}</span>}
      </div>
      {canAdd && <button type="button" className="btn small" onClick={add}><Plus size={14} />新增「{entered}」</button>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>, document.body)}
  </>;
}

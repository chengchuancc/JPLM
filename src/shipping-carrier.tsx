import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus } from "lucide-react";
import { CarrierTag, CarrierTags, carrierNames, path, type Request } from "./shipping-data";

export function CarrierPicker({ request, value, disabled, onChange }: {
  request: Request; value?: string | number; disabled: boolean; onChange: (value: string) => void;
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
  const selected = carrierNames(value);
  const entered = search.trim();
  const normalize = (name: string) => name.toLowerCase();
  const names = [...new Map([...options, ...selected].map((name) => [normalize(name), name])).values()];
  const available = names.filter((name) => normalize(name).includes(normalize(entered)));
  const canAdd = !!entered && !entered.includes("、") && !names.some((name) => normalize(name) === normalize(entered));

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
    request(path + "carriers").then((result) => { if (active) setOptions(result); },
      (failure) => { if (active) setError(failure.message); });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !popup.current?.contains(event.target))
        setPosition(undefined);
    };
    const reposition = (event: Event) => {
      if (anchor.current && !(event.target instanceof Node && popup.current?.contains(event.target))) setPosition(locate());
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [opened]);

  function toggle() {
    if (position) { setPosition(undefined); return; }
    setSearch("");
    setError("");
    setPosition(locate());
  }

  function choose(name: string) {
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
    <button ref={anchor} className="shipping-carrier-trigger" type="button" aria-label="选择承运商"
      aria-expanded={!!position} aria-controls={position ? panelId : undefined} disabled={disabled} onClick={toggle}>
      {selected.length ? <CarrierTags value={value} /> : <span className="muted">选择承运商</span>}
      <ChevronDown size={14} />
    </button>
    {position && createPortal(<div id={panelId} ref={popup} className="shipping-carrier-menu" style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setPosition(undefined); anchor.current?.focus(); }
      }}>
      <input ref={searchInput} aria-label="搜索或新增承运商" placeholder="搜索或新增承运商" maxLength={100} value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); }
        }} />
      <div className="shipping-carrier-options">
        {available.map((name) => <label key={name}>
          <input type="checkbox" checked={selected.some((item) => normalize(item) === normalize(name))}
            onChange={() => choose(name)} />
          <CarrierTag name={name} />
        </label>)}
        {!available.length && !entered && <span className="muted">暂无承运商</span>}
      </div>
      {canAdd && <button type="button" className="btn small" onClick={add}><Plus size={14} />新增「{entered}」</button>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>, document.body)}
  </>;
}

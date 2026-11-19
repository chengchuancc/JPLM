import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Check, ChevronDown, Palette } from "lucide-react";
import { colorAtHue, colorHue, defaultCustomColor, isThemeColor, readableAccent } from "./theme-color";
import "./theme.css";

const themes = [
  { id: "blue", label: "工程蓝" },
  { id: "green", label: "松石绿" },
  { id: "copper", label: "赤铜棕" },
  { id: "violet", label: "石板紫" },
  { id: "peach", label: "奶油桃" },
  { id: "mint", label: "薄荷奶绿" },
  { id: "taro", label: "香芋紫" },
  { id: "lemon", label: "柠檬奶黄" },
] as const;

type Theme = (typeof themes)[number]["id"] | "custom";
type Preference = { theme: Theme; color: string };
const storageKey = (userId: string) => "plm-theme-" + userId;
const defaultPreference: Preference = { theme: "blue", color: defaultCustomColor };

function matchingTheme(saved: unknown): Theme {
  if (saved === "custom") return saved;
  if (saved === "cyan") return "green";
  if (saved === "red" || saved === "orange" || saved === "yellow") return "copper";
  return themes.find(({ id }) => id === saved)?.id ?? "blue";
}

function readPreference(userId?: string): Preference {
  if (!userId) return defaultPreference;
  try {
    const saved = localStorage.getItem(storageKey(userId));
    if (!saved?.startsWith("{")) return { ...defaultPreference, theme: matchingTheme(saved) };
    const value = JSON.parse(saved);
    return {
      theme: matchingTheme(value?.theme),
      color: isThemeColor(value?.color) ? value.color : defaultCustomColor,
    };
  } catch {
    return defaultPreference;
  }
}

export function useAppearance(userId?: string) {
  const [choice, setChoice] = useState<{ userId: string; preference: Preference }>();
  const { theme, color } = choice && choice.userId === userId ? choice.preference : readPreference(userId);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.setProperty("--custom-color", color);
    root.style.setProperty("--custom-accent", readableAccent(color));
  }, [theme, color]);

  function selectTheme(next: Theme, nextColor = color) {
    if (!userId) return;
    const preference = { theme: next, color: nextColor };
    setChoice({ userId, preference });
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(preference));
    } catch {
      // The selection still applies for the current session.
    }
  }
  return { theme, color, selectTheme };
}

function ColorWheel({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const hue = colorHue(color);
  const setHue = (next: number) => onChange(colorAtHue((next + 360) % 360));
  function pointerHue(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    if (Math.hypot(x, y) >= rect.width * .18) setHue(Math.round(Math.atan2(x, -y) * 180 / Math.PI));
  }
  return <div className="theme-wheel" role="slider" tabIndex={0} aria-label="色轮色相"
    aria-valuemin={0} aria-valuemax={359} aria-valuenow={hue} aria-valuetext={hue + "°"}
    style={{ "--hue": hue + "deg", "--selected-color": color } as CSSProperties}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerHue(event);
    }}
    onPointerMove={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) pointerHue(event);
    }}
    onKeyDown={(event) => {
      const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!direction && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      setHue(event.key === "Home" ? 0 : event.key === "End" ? 359 : hue + direction! * (event.shiftKey ? 15 : 5));
    }}>
    <span aria-hidden="true" />
  </div>;
}

export function ThemePicker({ theme, color, selectTheme }: ReturnType<typeof useAppearance>) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const groupId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = themes.find(({ id }) => id === theme)?.label ?? "自定义";

  useEffect(() => {
    if (!open) return;
    (root.current?.querySelector<HTMLElement>('input:checked') ??
      root.current?.querySelector<HTMLElement>(".theme-custom > summary"))?.focus();

    function dismiss(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function changeColor(next: string) {
    selectTheme("custom", next);
  }

  return (
    <div className="theme-picker" ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}>
      <button ref={trigger} className="btn small theme-trigger" type="button"
        aria-label={"主题：" + selected} title="切换主题"
        aria-expanded={open} aria-controls={open ? groupId : undefined}
        onClick={() => {
          if (!open) setCustomOpen(theme === "custom");
          setOpen((value) => !value);
        }}>
        <Palette size={16} aria-hidden="true" />
        <span>{selected}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="theme-panel" id={groupId}>
          <fieldset className="theme-options">
            <legend>界面主题</legend>
            {themes.map(({ id, label }) => (
              <label className="theme-option" key={id}>
                <input type="radio" name={groupId} checked={theme === id} onChange={() => selectTheme(id)} />
                <span className="theme-preview" data-theme={id} aria-hidden="true" />
                <span className="theme-option-label">{label}{theme === id && <Check size={14} aria-hidden="true" />}</span>
              </label>
            ))}
          </fieldset>
          <details className="theme-custom" open={customOpen} onToggle={(event) => setCustomOpen(event.currentTarget.open)}>
            <summary>自定义配色 {theme === "custom" && <Check size={14} aria-label="当前主题" />}<ChevronDown size={14} aria-hidden="true" /></summary>
            <div className="theme-custom-body">
              <ColorWheel color={color} onChange={changeColor} />
              <div>
                <label className="theme-color-field">
                  精调颜色
                  <span><input type="color" value={color} onChange={(event) => changeColor(event.currentTarget.value)} />{color.toUpperCase()}</span>
                </label>
                {theme !== "custom" && <button type="button" className="btn small" onClick={() => changeColor(color)}>应用自定义色</button>}
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

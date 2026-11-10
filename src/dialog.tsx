import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focus = () =>
      (
        el.current?.querySelector<HTMLElement>(
          'input:not([type="file"]),select,textarea',
        ) || el.current?.querySelector<HTMLElement>("button")
      )?.focus();
    focus();
    const key = (e: KeyboardEvent) => {
      if (
        Array.from(document.querySelectorAll('.dialog[aria-modal="true"]')).at(
          -1,
        ) !== el.current
      )
        return;
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
      if (e.key === "Tab") {
        const a = Array.from(
          el.current?.querySelectorAll<HTMLElement>(
            "button,input,select,textarea,a[href]",
          ) || [],
        ).filter((x) => !x.hasAttribute("disabled"));
        if (!a.length) return;
        if (e.shiftKey && document.activeElement === a[0]) {
          e.preventDefault();
          a[a.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === a[a.length - 1]) {
          e.preventDefault();
          a[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={el}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog ${wide ? "wide" : ""}`}
      >
        <div className="dialog-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

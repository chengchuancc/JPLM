import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { randomUuid } from "./random-uuid";

type Entry = { id: string; previous: string | null; index: number; hash: string };
type Snapshot = { values: Record<string, unknown>; scroll?: { window: number; tables: [number, number][]; dialog?: number } };
const snapshots = new Map<string, Snapshot>();
const transient = new Map<string, Record<string, unknown>>();
const prefix = "plm-page:";
// History entry IDs keep separate visits to the same route independent.
const entryKey = "plmEntry";

export function clearNavigationSnapshots() {
  snapshots.clear();
  transient.clear();
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch { /* Browser storage may be unavailable. */ }
}

export async function restoreListPages<Page extends { rows: unknown[] }>(
  range: { first: number; last: number } | null, load: (page?: number) => Promise<Page>, key: (row: Page["rows"][number]) => string,
): Promise<Page> {
  if (!range) return load();
  const pages = await Promise.all(Array.from({ length: range.last - range.first + 1 }, (_, index) => load(range.first + index)));
  const rows = new Map(pages.flatMap((page) => page.rows.map((row) => [key(row), row])));
  return { ...pages[pages.length - 1], rows: [...rows.values()] };
}

function snapshot(id: string): Snapshot {
  if (!snapshots.has(id)) {
    let saved: Snapshot = { values: {} };
    try {
      const text = sessionStorage.getItem(prefix + id);
      if (text) saved = JSON.parse(text, (_key, value) =>
        value?.__plmSet === true && Array.isArray(value.values) ? new Set(value.values) : value);
    } catch { /* Browser storage may be unavailable. */ }
    snapshots.set(id, saved);
  }
  return snapshots.get(id)!;
}

function persist(id: string) {
  try {
    sessionStorage.setItem(prefix + id, JSON.stringify(snapshot(id), (_key, value) =>
      value instanceof Set ? { __plmSet: true, values: [...value] } : value));
  } catch { /* Keep navigation state in memory when storage is full. */ }
}

function currentEntry(): Entry {
  const saved = history.state?.[entryKey] as Entry | undefined;
  if (saved?.id && saved.hash === location.hash) return saved;
  const entry = { id: randomUuid(), previous: null, index: 0, hash: location.hash };
  history.replaceState({ ...history.state, [entryKey]: entry }, "", location.href);
  return entry;
}

function scrollContainers() {
  return [...document.querySelectorAll<HTMLElement>("main .table-wrap")];
}

function activeDialog() {
  const dialogs = document.querySelectorAll<HTMLElement>('.dialog[aria-modal="true"]');
  return dialogs[dialogs.length - 1];
}

function captureScroll(id: string) {
  snapshot(id).scroll = {
    window: window.scrollY,
    tables: scrollContainers().map((node) => [node.scrollLeft, node.scrollTop]),
    dialog: activeDialog()?.scrollTop,
  };
  persist(id);
}

export function useNavigationHistory<Route>({
  readRoute, routeHash, canLeave,
}: {
  readRoute: (hash?: string) => Route;
  routeHash: (route: Route) => string;
  canLeave: (current: Route, next: Route) => boolean;
}) {
  const [page, setPage] = useState(() => ({ route: readRoute(), entry: currentEntry() }));
  const current = useRef(page);
  const allow = useRef(canLeave);
  allow.current = canLeave;
  current.current = page;

  const navigate = useCallback((route: Route, replace = false, initial: Record<string, unknown> = {}) => {
    const previous = current.current;
    const hash = routeHash(route);
    if (!Object.keys(initial).length && (hash === previous.entry.hash || (!replace && hash === routeHash(previous.route)))) return;
    if (!allow.current(previous.route, route)) return;
    captureScroll(previous.entry.id);
    const entry = {
      id: randomUuid(), hash,
      previous: replace ? previous.entry.previous : previous.entry.id,
      index: replace ? previous.entry.index : previous.entry.index + 1,
    };
    snapshot(entry.id).values = initial;
    persist(entry.id);
    const state = { ...history.state, [entryKey]: entry };
    if (replace) history.replaceState(state, "", hash);
    else history.pushState(state, "", hash);
    current.current = { route, entry };
    setPage(current.current);
  }, [routeHash]);

  const back = useCallback((fallback: Route) => {
    if (current.current.entry.previous) history.back();
    else navigate(fallback, true);
  }, [navigate]);

  useEffect(() => {
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    let reverting = false;
    const changed = () => {
      const previous = current.current;
      const route = readRoute();
      const saved = history.state?.[entryKey] as Entry | undefined;
      if (saved?.id === previous.entry.id && saved.hash === location.hash) {
        reverting = false;
        return;
      }
      if (reverting) return;
      if (!allow.current(previous.route, route)) {
        const delta = saved ? previous.entry.index - saved.index : 0;
        if (delta) { reverting = true; history.go(delta); }
        else history.replaceState({ ...history.state, [entryKey]: previous.entry }, "", previous.entry.hash);
        return;
      }
      captureScroll(previous.entry.id);
      const entry = saved?.hash === location.hash ? saved : {
        id: randomUuid(), hash: location.hash,
        previous: previous.entry.id, index: previous.entry.index + 1,
      };
      history.replaceState({ ...history.state, [entryKey]: entry }, "", entry.hash);
      current.current = { route, entry };
      setPage(current.current);
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element)?.closest<HTMLAnchorElement>('a[href^="#"]');
      const hash = anchor?.getAttribute("href");
      if (!hash || anchor?.target === "_blank" || anchor?.hasAttribute("download")) return;
      event.preventDefault();
      navigate(readRoute(hash));
    };
    const save = () => captureScroll(current.current.entry.id);
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    window.addEventListener("pagehide", save);
    document.addEventListener("click", click);
    return () => {
      history.scrollRestoration = previousRestoration;
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("click", click);
    };
  }, [navigate, readRoute]);

  return { ...page, navigate, back };
}

const PageContext = createContext("");
export function NavigationPage({ id, children }: { id: string; children: ReactNode }) {
  useEffect(() => {
    const target = snapshot(id).scroll;
    const pending = new Map(target?.tables.map((position, index) => [index, position] as const).filter(([, [left, top]]) => left || top));
    let windowTop = target?.window ?? 0;
    let dialogTop = target?.dialog || 0;
    let frame = 0;
    let stopped = false;
    const restore = () => {
      if (stopped) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (windowTop >= 0) {
          window.scrollTo(0, windowTop);
          if (Math.abs(window.scrollY - windowTop) < 2) windowTop = -1;
        }
        const containers = scrollContainers();
        for (const [index, [left, top]] of pending) {
          const node = containers[index];
          if (!node) continue;
          node.scrollLeft = left;
          node.scrollTop = top;
          if (Math.abs(node.scrollLeft - left) < 2 && Math.abs(node.scrollTop - top) < 2) pending.delete(index);
        }
        const dialog = dialogTop && activeDialog();
        if (dialog) {
          dialog.scrollTop = dialogTop;
          if (Math.abs(dialog.scrollTop - dialogTop) < 2) dialogTop = 0;
        }
        if (windowTop < 0 && pending.size === 0 && !dialogTop) stop();
      });
    };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(document.body, { subtree: true, childList: true });
    const stop = () => { stopped = true; observer.disconnect(); cancelAnimationFrame(frame); };
    const timer = window.setTimeout(stop, 10000);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    return () => {
      stop();
      clearTimeout(timer);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
    };
  }, [id]);
  return <PageContext.Provider value={id}>{children}</PageContext.Provider>;
}

export function usePageState<T>(key: string, initial: T | (() => T), persistent = true): [T, Dispatch<SetStateAction<T>>] {
  const id = useContext(PageContext);
  const [value, setValue] = useState<T>(() => {
    const values = persistent ? snapshot(id).values : transient.get(id) || {};
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] as T : typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const latest = useRef(value);
  latest.current = value;
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const result = typeof next === "function" ? (next as (previous: T) => T)(latest.current) : next;
    latest.current = result;
    if (persistent) {
      snapshot(id).values[key] = result;
      persist(id);
    } else {
      const values = transient.get(id) || {};
      values[key] = result;
      transient.set(id, values);
    }
    setValue(result);
  }, [id, key, persistent]);
  return [value, set];
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Camera, CheckCircle2, ChevronDown, Delete, ImageOff, ScanLine, Search, Trash2 } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import { Dialog } from "./dialog";
import "./warehouse-registration.css";

type Material = {
  id: string;
  code: string;
  name: string;
  spec: string;
  unit: string;
  stock: number;
  location: string;
  project_id: string;
  project_name: string;
  image_id: string | null;
};
type Movement = "出库" | "入库" | "报废";
type HistoryEntry = {
  id: string; type: Movement; project_id: string; project_name: string; part_code: string; part_name: string;
  qty: number; unit: string; created_at: string; can_delete: boolean; expected: Record<string, unknown>;
};
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
const actions = [
  { kind: "出库", icon: ArrowUpFromLine, tone: "out" },
  { kind: "入库", icon: ArrowDownToLine, tone: "in" },
  { kind: "报废", icon: Trash2, tone: "scrap" },
] as const;
const numberKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Backspace"];
const formatNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });
const historyTime = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const completeScan = /^(?:JC\d{6}|https?:\/\/\S+#(?:projects\/[^/]+\/)?parts\/[a-f0-9]{24})$/i;

function useScannerInput(onScan: (value: string) => void) {
  const callback = useRef(onScan);
  callback.current = onScan;
  useEffect(() => {
    let buffer = "";
    let first = 0;
    let last = 0;
    let timer = 0;
    let completedAt = -Infinity;
    const reset = () => { buffer = ""; window.clearTimeout(timer); };
    const read = () => {
      const code = buffer.trim();
      reset();
      callback.current(code);
    };
    const scannerKey = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === "Tab") {
        const target = event.target;
        const editing = target instanceof HTMLInputElement;
        const fromSearch = editing && target.id === "warehouse-code";
        const elapsed = performance.now();
        const rapid = elapsed - first <= Math.max(350, buffer.length * 75);
        const scanned = buffer.trim().length >= 4 && elapsed - last < 300
          && (!editing || (rapid && (fromSearch ? completeScan.test(buffer) : /[^\d.]/.test(buffer))));
        if (elapsed - completedAt < 400 || scanned) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (buffer) read();
          completedAt = -Infinity;
        }
        reset();
        return;
      }
      if (event.key.length !== 1 || !/^[ -~]$/.test(event.key)) {
        if (event.key !== "Shift") reset();
        return;
      }
      const now = performance.now();
      if (now - last > 200 || buffer.length >= 1000) reset();
      if (!buffer) first = now;
      buffer += event.key;
      last = now;
      completedAt = -Infinity;
      window.clearTimeout(timer);
      if (event.target instanceof HTMLInputElement && event.target.id === "warehouse-quantity" && /[^\d.]/.test(buffer)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      // Some scanners omit the Enter/Tab suffix. These formats have a known end.
      if (completeScan.test(buffer) && now - first <= buffer.length * 75) {
        timer = window.setTimeout(() => {
          completedAt = performance.now();
          read();
        }, 160);
      }
    };
    window.addEventListener("keydown", scannerKey, true);
    return () => { window.removeEventListener("keydown", scannerKey, true); reset(); };
  }, []);
}

function MaterialImage({ material }: { material: Material }) {
  const [failed, setFailed] = useState(false);
  return <div className="warehouse-material-image">
    {material.image_id && !failed ? <img src={new URL("files/" + encodeURIComponent(material.image_id), document.baseURI).href}
      alt={material.name + "图片"} onError={() => setFailed(true)} /> : <ImageOff size={26} aria-label="暂无图片" />}
  </div>;
}

function ScanCamera({ onRead, onError, close }: {
  onRead: (text: string) => void;
  onError: (message: string) => void;
  close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [deviceId, setDeviceId] = useState("");
  const [currentDevice, setCurrentDevice] = useState("");
  const [lenses, setLenses] = useState<string[]>([]);
  const callbacks = useRef({ onRead, onError });
  callbacks.current = { onRead, onError };
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      callbacks.current.onError("无法使用摄像头，请通过 HTTPS 打开此页。");
      return;
    }
    let active = true;
    let stream: MediaStream | undefined;
    let controls: IScannerControls | undefined;
    void Promise.all([import("@zxing/browser"), import("@zxing/library")]).then(async ([{ BrowserMultiFormatReader }, { DecodeHintType }]) => {
      if (!active) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 }, height: { ideal: 1080 },
        },
      });
      if (!active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
      if (capabilities?.focusMode?.includes("continuous")) {
        const constraints = track.getConstraints();
        const continuousFocus = { focusMode: "continuous" } as MediaTrackConstraintSet;
        void track.applyConstraints({ ...constraints, advanced: [...(constraints.advanced ?? []), continuousFocus] })
          .catch(() => {});
      }
      const selected = track.getSettings().deviceId || deviceId;
      setCurrentDevice(selected);
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (!active) return;
        const rear = devices.filter((device) => device.kind === "videoinput"
          && /back|rear|environment|后置|背面|背部/i.test(device.label));
        setLenses([...new Set([selected, ...rear.map((device) => device.deviceId)].filter(Boolean))]);
      }).catch(() => {});
      const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
      controls = await new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 160 }).decodeFromStream(
        stream,
        element,
        (result, _error, session) => {
          if (!active || !result) return;
          active = false;
          session.stop();
          callbacks.current.onRead(result.getText());
        },
      );
      if (!active) controls.stop();
    }).catch(() => {
      stream?.getTracks().forEach((track) => track.stop());
      if (!active) return;
      if (deviceId) setDeviceId("");
      else callbacks.current.onError("无法打开摄像头，请检查浏览器的摄像头权限。");
    });
    return () => {
      active = false;
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [deviceId]);
  return <div className="warehouse-camera">
    <div className="warehouse-camera-preview">
      <video key={deviceId} ref={video} muted playsInline autoPlay aria-label="摄像头画面" />
      <span className="warehouse-scan-frame" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
    </div>
    <p className="muted">将二维码放进框内，画面模糊时稍微移远。</p>
    <div className="warehouse-camera-actions">
      <button className="warehouse-secondary" type="button" onClick={close}>关闭摄像头</button>
      {lenses.length > 1 && <button className="warehouse-secondary" type="button"
        onClick={() => setDeviceId(lenses[(lenses.indexOf(currentDevice) + 1) % lenses.length])}>切换镜头</button>}
    </div>
  </div>;
}

export default function WarehouseRegistration({ request }: { request: Request }) {
  const [code, setCode] = useState("");
  const [material, setMaterial] = useState<Material>();
  const [matches, setMatches] = useState<Material[]>([]);
  const [movement, setMovement] = useState<Movement>();
  const [quantity, setQuantity] = useState("");
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [remove, setRemove] = useState<HistoryEntry>();
  const [removeError, setRemoveError] = useState("");
  const [touch] = useState(() => matchMedia("(pointer: coarse)").matches);
  const input = useRef<HTMLInputElement>(null);
  const quantityInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const retry = useRef<{ quantity: number; id: string } | undefined>(undefined);

  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    request("warehouse/movements").then((rows: HistoryEntry[]) => {
      if (active) { setHistory(rows); setHistoryError(""); }
    }, (failure: Error) => {
      if (active) setHistoryError(failure.message);
    });
    return () => { active = false; };
  }, [request, historyOpen, historyVersion]);

  useEffect(() => {
    if (busy || camera) return;
    if (movement) quantityInput.current?.focus();
    else if (!material) input.current?.focus();
  }, [busy, camera, material, movement]);

  function choose(result: Material) {
    retry.current = undefined;
    setRemove(undefined);
    setMatches([]);
    setMovement(undefined);
    setQuantity("");
    setCode("");
    setMaterial(result);
  }

  async function lookup(value: string, exact = false) {
    const term = value.trim();
    if (!term || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCamera(false);
    setError("");
    setReceipt("");
    setMatches([]);
    try {
      const result = await request("warehouse/material?" + new URLSearchParams(exact ? { q: term } : { q: term, fuzzy: "1" }));
      if (exact) choose(result);
      else if (result.rows.length === 1) choose(result.rows[0]);
      else if (result.rows.length) setMatches(result.rows);
      else setError("没有找到匹配物料，请试试编号、名称或规格。");
    } catch (failure) {
      setError((failure as Error).message);
      if (exact && !material) setCode("");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  useScannerInput((value) => void lookup(value, true));

  function codeKey(key: string) {
    setError("");
    setMatches([]);
    setCode((value) => key === "Backspace" ? value.slice(0, -1) : (value + key).slice(0, 1000));
    input.current?.focus();
  }

  function quantityKey(key: string) {
    setError("");
    setQuantity((value) => {
      if (key === "Backspace") return value.slice(0, -1);
      if (key === "." && value.includes(".")) return value;
      const next = key === "." && !value ? "0." : value + key;
      return /^\d{1,10}(?:\.\d{0,6})?$/.test(next) ? next : value;
    });
    quantityInput.current?.focus();
  }

  function keyboard(event: KeyboardEvent<HTMLInputElement>, append: (key: string) => void, accepted: RegExp) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" || accepted.test(event.key)) {
      event.preventDefault();
      append(event.key);
    }
  }

  function reset() {
    retry.current = undefined;
    setMaterial(undefined);
    setMovement(undefined);
    setCode("");
    setQuantity("");
    setError("");
    setMatches([]);
  }

  const qty = Number(quantity);
  const validQty = Number.isFinite(qty) && qty > 0 && qty <= 1e9;
  async function confirm() {
    if (!material || !movement || !validQty || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    if (retry.current?.quantity !== qty) {
      const random = crypto.getRandomValues(new Uint8Array(16));
      retry.current = { quantity: qty, id: Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("") };
    }
    try {
      const saved = await request("warehouse/movements", "POST", {
        project_id: material.project_id, part_id: material.id, type: movement, qty, request_id: retry.current.id,
      });
      setReceipt(`已登记 ${material.name} · ${movement} ${formatNumber.format(qty)} ${material.unit} · 结余 ${formatNumber.format(saved.stock)} ${material.unit}`);
      reset();
      setHistoryVersion((value) => value + 1);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!remove || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRemoveError("");
    try {
      const result: { part_id: string; stock: number } = await request("warehouse/movements/" + remove.id, "DELETE", {
        project_id: remove.project_id, expected: remove.expected,
      });
      setMaterial((current) => current?.id === result.part_id ? { ...current, stock: result.stock } : current);
      setReceipt(`已删除 ${remove.part_name}的${remove.type}记录 · 结余 ${formatNumber.format(result.stock)} ${remove.unit}`);
      setHistory((current) => current?.filter((row) => row.id !== remove.id));
      setRemove(undefined);
      setHistoryVersion((value) => value + 1);
    } catch (failure) {
      setRemoveError((failure as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <main className="warehouse-page">
    <header className="warehouse-title"><ScanLine aria-hidden="true" /><h1>出入库登记</h1></header>
    {receipt && <div className="warehouse-receipt" role="status"><CheckCircle2 size={22} /><span>{receipt}</span></div>}
    {!material ? <section className="warehouse-card">
      <form onSubmit={(event) => { event.preventDefault(); void lookup(code); }}>
        <label className="warehouse-label" htmlFor="warehouse-code">扫码或查询物料</label>
        <div className="warehouse-search">
          <input id="warehouse-code" ref={input} value={code} readOnly={touch} inputMode="none" autoComplete="off"
            maxLength={1000} placeholder="编号、名称或规格" disabled={busy}
            onChange={(event) => { setCode(event.target.value); setMatches([]); setError(""); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") { event.preventDefault(); void lookup(code); }
              else if (touch) keyboard(event, codeKey, /^[ -~]$/);
            }}
            onPaste={(event) => {
              event.preventDefault();
              setCode(event.clipboardData.getData("text").trim().slice(0, 1000));
              setMatches([]);
            }} />
          <button className="warehouse-primary" type="submit" disabled={!code.trim() || busy}><Search size={20} />{busy ? "查询中" : "查询"}</button>
        </div>
      </form>
      {error && <p className="warehouse-error" role="alert">{error}</p>}
      {!!matches.length && <div className="warehouse-matches" aria-label="匹配物料">
        {matches.map((item) => <button type="button" key={item.id} disabled={busy} onClick={() => choose(item)}>
          <MaterialImage material={item} />
          <span><strong>{item.name}</strong><small>{[item.code, item.spec, item.project_name].filter(Boolean).join(" · ")}</small></span>
        </button>)}
      </div>}
      {camera ? <ScanCamera close={() => setCamera(false)} onRead={(value) => void lookup(value, true)} onError={(message) => {
        setCamera(false);
        setError(message);
      }} /> : <>
        <button className="warehouse-secondary warehouse-camera-button" type="button" disabled={busy}
          onClick={() => { setError(""); setCamera(true); }}><Camera size={22} />摄像头扫码</button>
        <div className="warehouse-code-keyboard warehouse-number-keyboard" role="group" aria-label="物料编号键盘">
          {numberKeys.map((key) => key === "." ? <span key={key} /> : <button key={key} type="button" disabled={busy}
            aria-label={key === "Backspace" ? "删除最后一位" : undefined} onClick={() => codeKey(key)}>
            {key === "Backspace" ? <Delete size={25} /> : key}
          </button>)}
        </div>
      </>}
    </section> : <section className="warehouse-card">
      <div className="warehouse-material">
        <MaterialImage key={material.image_id ?? material.id} material={material} />
        <div className="warehouse-material-text">
          <span className="warehouse-code">{material.code}</span>
          <h2>{material.name}</h2>
          <p>{[material.spec, material.project_name, material.location].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="warehouse-stock"><span>当前库存</span><strong>{formatNumber.format(material.stock)} <small>{material.unit}</small></strong></div>
      </div>
      {!movement && error && <p className="warehouse-error" role="alert">{error}</p>}
      {movement ? <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <label className="warehouse-label" htmlFor="warehouse-quantity">{movement}数量</label>
        <div className="warehouse-quantity">
          <input id="warehouse-quantity" ref={quantityInput} value={quantity} readOnly inputMode="none" placeholder="0" disabled={busy}
            onKeyDown={(event) => keyboard(event, quantityKey, /^[0-9.]$/)} />
          <span>{material.unit}</span>
        </div>
        <div className="warehouse-number-keyboard" role="group" aria-label="数量键盘">
          {numberKeys.map((key) => <button key={key} type="button" disabled={busy}
            aria-label={key === "Backspace" ? "删除最后一位" : undefined} onClick={() => quantityKey(key)}>
            {key === "Backspace" ? <Delete size={25} /> : key}
          </button>)}
        </div>
        {error && <p className="warehouse-error" role="alert">{error}</p>}
        <div className="warehouse-confirm">
          <button className="warehouse-secondary" type="button" disabled={busy}
            onClick={() => { retry.current = undefined; setMovement(undefined); setQuantity(""); setError(""); }}>返回</button>
          <button className="warehouse-primary" type="submit" disabled={!validQty || busy}>{busy ? "登记中…" : "确认" + movement}</button>
        </div>
      </form> : <>
        <div className="warehouse-actions">
          {actions.map(({ kind, icon: Icon, tone }) => <button key={kind} type="button" className={"warehouse-action " + tone}
            onClick={() => setMovement(kind)}><Icon size={28} aria-hidden="true" />{kind}</button>)}
        </div>
        <button className="warehouse-secondary" type="button" onClick={reset}>重新扫码</button>
      </>}
    </section>}
    <details className="warehouse-card warehouse-history" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
      <summary>我的出入库记录 <ChevronDown size={18} aria-hidden="true" /></summary>
      {historyError && <p className="warehouse-error" role="alert">{historyError}</p>}
      {history?.length ? <ul>{history.map((row) => <li key={row.id}>
        <div><strong>{row.type} {formatNumber.format(row.qty)} {row.unit} · {row.part_name}</strong>
          <small>{historyTime.format(new Date(row.created_at))} · {row.part_code} · {row.project_name}</small></div>
        {!!row.can_delete && <button type="button" className="warehouse-delete" disabled={busy}
          aria-label={`删除${row.part_name}的${row.type}记录`} onClick={() => { setRemoveError(""); setRemove(row); }}>
          <Trash2 size={16} />删除
        </button>}
      </li>)}</ul> : !historyError && <p className="muted">{history ? "暂无登记记录" : "正在读取记录…"}</p>}
    </details>
    {remove && <Dialog title="确认删除库存流水" onClose={() => { if (!inFlight.current) setRemove(undefined); }}>
      <p>{remove.part_name} · {remove.type} {formatNumber.format(remove.qty)} {remove.unit}。删除后会重新计算库存。</p>
      {removeError && <p className="form-error" role="alert">{removeError}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => setRemove(undefined)}>取消</button>
        <button type="button" className="btn primary warehouse-delete-confirm" disabled={busy} onClick={() => void confirmDelete()}>
          {busy ? "删除中…" : "确认删除"}
        </button>
      </div>
    </Dialog>}
  </main>;
}

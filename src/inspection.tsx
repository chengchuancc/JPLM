import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Camera, ChevronDown, Download, Plus, Search, Upload, X } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import { Dialog } from "./dialog";
import "./inspection.css";

type Value = string | number | string[];
type Values = Record<string, Value>;
type FieldType = "choice" | "multi" | "number" | "text";
type SerialMode = "text" | "dated";

type InspectionField = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  required: boolean;
  options: string[];
  fail: string[];
  unit: string;
  minimum: number | null;
  maximum: number | null;
  custom: boolean;
  display?: "buttons" | "dropdown";
  block?: string;
  auto_from?: string;
};
type Template = {
  id: string;
  name: string;
  serial_mode: SerialMode;
  fields: InspectionField[];
  revision: number;
};
type RecordRow = {
  id: string;
  serial: string;
  prefix: string;
  production_date: string;
  result: string;
  operator_name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  source_id: string;
  values: Values;
  form: Template;
};
type RecordPage = { records: RecordRow[]; total: number; page: number; per_page: number };
type Device = {
  serial: string;
  prefix: string;
  production_date: string;
  registered_at: string;
  operator_name: string;
  records: number;
  result: string | null;
};
type DevicePage = { devices: Device[]; total: number; page: number };
type SavedOption = { field_key: string; value: string; hidden_at: string | null };
type ImportReport = {
  ready: number;
  duplicates: number;
  invalid: number;
  ignored: string[];
  errors: { row: number; error: string }[];
  sample: { serial: string; result: string }[];
  revision: number;
};
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
type Filters = {
  keyword: string; serial: string; prefix: string; prefix_from: string; prefix_to: string;
  result: string; from: string; to: string;
};
const defaultFilters: Filters = {
  keyword: "", serial: "", prefix: "", prefix_from: "", prefix_to: "", result: "", from: "", to: "",
};
const results = ["合格", "不良", "未完成", "待检测"];
const action = "btn";
const primary = "btn primary";
const inspectionPath = "inspection/";

function formatTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}
function parameters(id: string, query: Record<string, string> = {}) {
  return new URLSearchParams({ template: id, ...query }).toString();
}
function decision(fields: InspectionField[], values: Values) {
  let incomplete = false;
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      incomplete ||= field.required;
      continue;
    }
    if (field.type === "number") {
      const numeric = Number(value);
      if (outsideRange(field, numeric)) return "不良";
    } else if ((Array.isArray(value) ? value : [String(value)]).some((choice) => field.fail.includes(choice))) {
      return "不良";
    }
  }
  return incomplete || !Object.keys(values).length ? "未完成" : "合格";
}

function outsideRange(field: InspectionField, value: number) {
  return (field.minimum !== null && value < field.minimum) ||
    (field.maximum !== null && value > field.maximum);
}

function automaticValues(fields: InspectionField[], values: Values, original?: Values) {
  const result = { ...values };
  for (const field of fields) {
    if (!field.auto_from) continue;
    const source = fields.find((item) => item.key === field.auto_from);
    const value = values[field.auto_from];
    if (original && value === original[field.auto_from]) continue;
    if (!source || value === undefined || value === "") delete result[field.key];
    else result[field.key] = outsideRange(source, Number(value)) ? "NG" : "OK";
  }
  return result;
}

function ResultLabel({ value }: { value: string }) {
  const tone = value === "不良" || value === "NG" ? "fail" : value === "合格" || value === "OK" ? "pass" :
    value === "未完成" ? "incomplete" : "pending";
  return <span className={"inspection-result " + tone}>{value}</span>;
}

export function CameraReader({ live, onRead, close }: {
  live: boolean; onRead: (value: string) => void; close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const read = useRef(onRead);
  read.current = onRead;
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [frameReady, setFrameReady] = useState(false);
  const [message, setMessage] = useState("");
  const [readingPhoto, setReadingPhoto] = useState(false);
  const photoGeneration = useRef(0);
  useEffect(() => () => { ++photoGeneration.current; }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  useEffect(() => {
    if (!live || !video.current) return;
    const element = video.current;
    let active = true;
    let controls: IScannerControls | undefined;
    setMessage("");
    setFrameReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("当前浏览器无法打开摄像头，可以选择条码照片。");
      return;
    }
    void import("@zxing/browser").then(async ({ BrowserMultiFormatReader }) => {
      if (!active) return;
      const reader = new BrowserMultiFormatReader();
      controls = await reader.decodeFromConstraints(
        { audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1280 } } },
        element,
        (result, _error, session) => {
          if (!active || !result) return;
          active = false;
          session.stop();
          read.current(result.getText());
        },
      );
      if (!active) {
        controls.stop();
        return;
      }
      setFrameReady(true);
      navigator.mediaDevices.enumerateDevices().then((items) => {
        if (active) setDevices(items.filter((item) => item.kind === "videoinput"));
      }).catch(() => {});
    }).catch(() => {
      if (active) setMessage("无法打开摄像头。请检查浏览器权限，或选择条码照片。");
    });
    return () => {
      active = false;
      controls?.stop();
      if (element.srcObject instanceof MediaStream)
        element.srcObject.getTracks().forEach((track) => track.stop());
    };
  }, [deviceId, live]);

  async function scanPhoto(file?: Blob) {
    if (!file || readingPhoto) return;
    setReadingPhoto(true);
    setMessage("");
    const ticket = ++photoGeneration.current;
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      if (ticket === photoGeneration.current) read.current(result.getText());
    } catch {
      if (ticket === photoGeneration.current) setMessage("没有识别到条码。请确认照片清晰、编号完整。");
    } finally {
      URL.revokeObjectURL(url);
      if (ticket === photoGeneration.current) setReadingPhoto(false);
    }
  }
  function captureFrame() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) {
      setMessage("摄像头画面还没准备好。");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) void scanPhoto(blob);
      else setMessage("无法截取摄像头画面。");
    }, "image/jpeg", .94);
  }
  return (
    <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="dialog inspection-camera" role="dialog" aria-modal="true" aria-label="扫码识别 S/N">
        <div className="dialog-heading">
          <h2>扫码识别 S/N</h2>
          <button className="icon-btn" type="button" onClick={close} aria-label="关闭扫码"><X size={20} /></button>
        </div>
        {live && <video ref={video} muted playsInline autoPlay aria-label="摄像头预览" />}
        {message && <p className="form-error" role="alert">{message}</p>}
        <div className="dialog-actions">
          {live && devices.length > 1 && <button type="button" className={action} onClick={() => {
            const stream = video.current?.srcObject;
            const current = stream instanceof MediaStream ? stream.getVideoTracks()[0]?.getSettings().deviceId : deviceId;
            const next = (devices.findIndex((device) => device.deviceId === current) + 1) % devices.length;
            setDeviceId(devices[next].deviceId);
          }}>切换摄像头</button>}
          {live && <button type="button" className={action} disabled={!frameReady || readingPhoto}
            onClick={captureFrame}>拍照识别</button>}
          <label className={primary}>
            {readingPhoto ? "正在识别…" : "选择条码照片"}
            <input type="file" accept="image/*" hidden disabled={readingPhoto}
              aria-label="选择条码照片" onChange={(event) => void scanPhoto(event.target.files?.[0])} />
          </label>
        </div>
      </section>
    </div>
  );
}

function FieldInput({ field, value, suggestions, hidden, automatic, onChange }: {
  field: InspectionField;
  value?: Value;
  suggestions: string[];
  hidden: string[];
  automatic?: { field: InspectionField; value?: Value };
  onChange: (value: Value | undefined) => void;
}) {
  const [search, setSearch] = useState("");
  const dropdown = field.display === "dropdown";
  const details = useRef<HTMLDetailsElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dropdown) return;
    function outside(event: PointerEvent) {
      const panel = details.current;
      if (panel?.open && event.target instanceof Node && !panel.contains(event.target)) panel.open = false;
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [dropdown]);
  const selected = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
  const selectionTone = selected.some((option) => field.fail.includes(option)) ? " is-fail" :
    selected.length ? " has-selection" : "";
  const options = Array.from(new Set([...field.options.filter((item) => !hidden.includes(item)), ...suggestions, ...selected]));
  const entered = search.trim();
  const term = entered.toLowerCase();
  const filtered = term ? options.filter((option) => option.toLowerCase().includes(term)) : options;
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : null;
  const hasLimit = field.minimum !== null || field.maximum !== null;
  const verdict = automatic ? automatic.value : numeric === null ? undefined : outsideRange(field, numeric) ? "NG" : "OK";
  function addChoice() {
    if (!entered) return;
    onChange(Array.from(new Set([...selected, entered])));
    setSearch("");
  }
  function choose(option: string) {
    if (field.type === "choice") {
      onChange(value === option ? undefined : option);
      if (details.current) details.current.open = false;
    } else {
      onChange(selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option]);
    }
  }
  const choices = <div className="inspection-choices">
    {filtered.map((option) => <button key={option} type="button"
      className={"inspection-choice" + (field.fail.includes(option) ? " is-fail" :
        option === "OK" && field.fail.includes("NG") ? " is-pass" : "")}
      aria-pressed={selected.includes(option)} onClick={() => choose(option)}>{option}</button>)}
    {!filtered.length && term && <small className="muted">无匹配选项</small>}
  </div>;
  const searchBox = <div className="inspection-custom">
    <input ref={searchInput} aria-label={field.label + " 搜索选项"} placeholder={field.custom ? "搜索或输入新选项" : "搜索选项"}
      maxLength={250} value={search} onChange={(event) => setSearch(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (field.custom) addChoice();
          else if (filtered.length === 1) choose(filtered[0]);
        }
      }} />
    {field.custom && <button type="button" className="btn small" disabled={!entered} onClick={addChoice}>新增当前输入</button>}
  </div>;
  return (
    <fieldset className="inspection-field">
      <legend>{field.label}{(field.required || automatic?.field.required) && <span className="required"> *</span>}</legend>
      {(field.type === "choice" || field.type === "multi") ? (
        dropdown ? <details ref={details} className="inspection-dropdown" onToggle={(event) => {
          if (event.currentTarget.open) searchInput.current?.focus();
          else setSearch("");
        }} onKeyDown={(event) => {
          if (event.key === "Escape" && details.current?.open) {
            event.preventDefault();
            details.current.open = false;
            details.current.querySelector("summary")?.focus();
          }
        }}>
          <summary aria-label={field.label + " 选项"} className={selectionTone.trim()}>
            <span className={selected.length ? "" : "muted"}>
              {selected.join(" / ") || (field.type === "multi" ? "请选择一项或多项" : "请选择")}
            </span><ChevronDown size={16} />
          </summary>
          <div className="inspection-dropdown-panel">{searchBox}{choices}</div>
        </details> : <>{choices}{field.custom && searchBox}</>
      ) : field.type === "number" ? (
        <>
          <div className="inspection-measurement">
            <input type="number" step="any" aria-label={field.label} value={value === undefined ? "" : String(value)}
              onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)} />
            {field.unit && <span>{field.unit}</span>}
            {hasLimit && (automatic || numeric !== null) && <span
              aria-label={automatic?.field.label} className={"inspection-result " +
                (verdict === "NG" ? "fail" : verdict === "OK" ? "pass" : "pending")}>
              {verdict === "NG" || verdict === "OK" ? verdict : "未判定"}
            </span>}
          </div>
          {hasLimit && <small className="muted">
            {field.minimum === null ? "≤ " + field.maximum : field.maximum === null ? "≥ " + field.minimum :
              field.minimum + "–" + field.maximum} {field.unit}
          </small>}
        </>
      ) : (
        <textarea rows={2} maxLength={2000} aria-label={field.label} value={value === undefined ? "" : String(value)}
          onChange={(event) => onChange(event.target.value || undefined)} />
      )}
    </fieldset>
  );
}

function sections(fields: InspectionField[]) {
  const groups = new Map<string, InspectionField[]>();
  for (const field of fields) {
    const group = field.group || "检测项";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(field);
  }
  return [...groups];
}

function InspectionFields({ form, values, original, savedOptions = [], onChange }: {
  form: Template; values: Values; original?: Values; savedOptions?: SavedOption[];
  onChange: (key: string, value: Value | undefined) => void;
}) {
  const computed = automaticValues(form.fields, values, original);
  function render(field: InspectionField) {
    const automatic = form.fields.find((item) => item.auto_from === field.key);
    const options = savedOptions.filter((item) => item.field_key === field.key);
    return <FieldInput key={form.id + ":" + form.revision + ":" + field.key}
      field={field} value={values[field.key]}
      automatic={automatic && { field: automatic, value: computed[automatic.key] }}
      suggestions={options.filter((item) => !item.hidden_at).map((item) => item.value)}
      hidden={options.filter((item) => item.hidden_at).map((item) => item.value)}
      onChange={(value) => onChange(field.key, value)} />;
  }
  return sections(form.fields).map(([group, fields]) => {
    const blocks = new Map<string, InspectionField[]>();
    for (const field of fields) {
      if (field.auto_from) continue;
      const key = field.block ? "block:" + field.block : "field:" + field.key;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key)!.push(field);
    }
    if (!blocks.size) return null;
    return <section className="panel inspection-field-group" key={group}>
      <h3>{group}</h3>
      <div className="inspection-field-grid">
        {[...blocks].map(([key, items]) => items[0].block
          ? <div className="inspection-block" key={key}>
              {(items.length > 1 || items[0].label !== items[0].block) && <h4>{items[0].block}</h4>}
              <div className="inspection-field-grid">{items.map(render)}</div>
            </div>
          : render(items[0]))}
      </div>
    </section>;
  });
}

function withValue(values: Values, key: string, value: Value | undefined) {
  const next = { ...values };
  if (value === undefined || (Array.isArray(value) && !value.length)) delete next[key];
  else next[key] = value;
  return next;
}

function newField(group: string, label = "", type: FieldType = "choice"): InspectionField {
  return {
    key: "field_" + crypto.randomUUID().replaceAll("-", ""), label, group, type,
    options: type === "choice" ? ["OK", "NG"] : [], fail: type === "choice" ? ["NG"] : [],
    minimum: null, maximum: null, unit: "", custom: false, required: type !== "text",
    display: type === "multi" ? "dropdown" : "buttons", block: "", auto_from: "",
  };
}

const fieldTypes: [FieldType, string][] = [["choice", "单选"], ["multi", "多选"], ["number", "数值"], ["text", "文本"]];
const lines = (value: string) => [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];

function FieldSettings({ field, fields, update }: {
  field: InspectionField; fields: InspectionField[]; update: (patch: Partial<InspectionField>) => void;
}) {
  const selectable = field.type === "choice" || field.type === "multi";
  const candidates = fields.filter((item) => item.key !== field.key && item.type === "number" &&
    (item.minimum !== null || item.maximum !== null) &&
    !fields.some((other) => other.key !== field.key && other.auto_from === item.key));
  const [optionText, setOptionText] = useState(field.options.join("\n"));
  const setOptions = (value: string) => {
    setOptionText(value);
    const options = lines(value);
    update({ options, fail: field.fail.filter((item) => options.includes(item)) });
  };
  return <>
    <div className="inspection-config-grid">
      <label>检测项名称<input required maxLength={80} value={field.label} onChange={(e) => update({ label: e.target.value })} /></label>
      <label>类型<select aria-label="类型" value={field.auto_from ? "automatic" : field.type} onChange={(e) => {
        const type = e.target.value;
        if (type === "automatic") {
          const source = candidates[0];
          update({ type: "choice", options: ["OK", "NG"], fail: ["NG"], display: "buttons",
            custom: false, auto_from: source.key });
          setOptionText("OK\nNG");
        } else {
          const defaults = newField(field.group, field.label, type as FieldType);
          update({ type: defaults.type, options: defaults.options, fail: defaults.fail,
            display: defaults.display, custom: false, auto_from: "", minimum: null, maximum: null, unit: "" });
          setOptionText(defaults.options.join("\n"));
        }
      }}>
        {fieldTypes.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        <option value="automatic" disabled={!candidates.length && !field.auto_from}>
          {!candidates.length && !field.auto_from ? "自动判定（先配置数值范围）" : "自动判定"}
        </option>
      </select></label>
      <label>分组<input required maxLength={60} list="inspection-group-names" value={field.group}
        disabled={!!field.auto_from} onChange={(e) => update({ group: e.target.value })} /></label>
      <datalist id="inspection-group-names">{sections(fields).map(([group]) => <option key={group} value={group} />)}</datalist>
      <label>组合名称<input maxLength={60} value={field.block || ""} placeholder="选填，如空间测量"
        disabled={!!field.auto_from} list="inspection-block-names" onChange={(e) => update({ block: e.target.value })} /></label>
      <datalist id="inspection-block-names">{[...new Set(fields.filter((item) => item.group === field.group && item.block)
        .map((item) => item.block!))].map((block) => <option key={block} value={block} />)}</datalist>
      {field.auto_from && <label>取值来源<select aria-label="取值来源" value={field.auto_from} onChange={(e) => update({ auto_from: e.target.value })}>
        {!candidates.some((item) => item.key === field.auto_from) &&
          <option value={field.auto_from}>请选择有效的数值项</option>}
        {candidates.map((item) => <option key={item.key} value={item.key}>{item.group} · {item.label || "数值项"}</option>)}
      </select></label>}
      {field.type === "number" && <>
        <label>单位<input value={field.unit} maxLength={24} onChange={(e) => update({ unit: e.target.value })} /></label>
        <label>合格下限<input type="number" step="any" value={field.minimum ?? ""}
          onChange={(e) => update({ minimum: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        <label>合格上限<input type="number" step="any" value={field.maximum ?? ""}
          onChange={(e) => update({ maximum: e.target.value === "" ? null : Number(e.target.value) })} /></label>
      </>}
      {selectable && !field.auto_from && <label>选择样式<select value={field.display || "buttons"}
        onChange={(e) => update({ display: e.target.value as InspectionField["display"] })}>
        <option value="buttons">平铺按钮</option><option value="dropdown">搜索下拉</option>
      </select></label>}
    </div>
    {selectable && !field.auto_from && <div className="inspection-editor-main">
      <label>选项（每行一个）<textarea rows={4} value={optionText} onChange={(e) => setOptions(e.target.value)} /></label>
      <div className="inspection-fail-options">
        <span>判为不良的选项</span>
        {field.options.map((option) => <label key={option}>
          <input type="checkbox" checked={field.fail.includes(option)} onChange={(e) => update({
            fail: e.target.checked ? [...field.fail, option] : field.fail.filter((value) => value !== option),
          })} />{option}
        </label>)}
      </div>
    </div>}
    <div className="inspection-checks">
      <label><input type="checkbox" checked={field.required} onChange={(e) => update({ required: e.target.checked })} />必检项</label>
      {field.type === "multi" && <label><input type="checkbox" checked={field.custom}
        onChange={(e) => update({ custom: e.target.checked })} />允许现场添加选项</label>}
    </div>
  </>;
}

function TemplateEditor({ template, copy, save, cancel, onDirty }: {
  template: Template | null; copy?: Template; save: (data: unknown) => Promise<void>; cancel: () => void;
  onDirty: () => void;
}) {
  const [name, setName] = useState(template?.name || (copy ? copy.name + " 副本" : "出厂检测"));
  const [mode, setMode] = useState<SerialMode>(template?.serial_mode || copy?.serial_mode || "text");
  const [fields, setFields] = useState<InspectionField[]>(() => template?.fields || copy?.fields ||
    [newField("功能与反馈", "功能检测"), newField("外观", "外观检测"), newField("其他说明", "备注", "text")]);
  const [selected, setSelected] = useState(() => fields[0].key);
  const [preview, setPreview] = useState(false);
  const [sample, setSample] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = fields.find((item) => item.key === selected) || fields[0];
  const groups = sections(fields);
  const fieldGroup = groups.findIndex(([, items]) => items.includes(field));
  const groupItems = groups[fieldGroup][1];
  const fieldIndex = groupItems.indexOf(field);
  function update(patch: Partial<InspectionField>) {
    setFields((previous) => previous.map((item) => {
      if (item.key !== field.key) return item;
      const next = { ...item, ...patch };
      if (patch.auto_from) {
        const source = previous.find((candidate) => candidate.key === patch.auto_from)!;
        next.group = source.group;
        next.block = source.block || source.label || "测量";
      }
      return next;
    }).map((item) => {
      const linked = patch.auto_from && item.key === patch.auto_from;
      if (linked && !item.block) return { ...item, block: item.label || "测量" };
      if (item.auto_from === field.key) {
        return { ...item, group: patch.group ?? item.group, block: patch.block ?? item.block,
          auto_from: patch.type && patch.type !== "number" ? "" : item.auto_from };
      }
      return item;
    }));
    onDirty();
  }
  function move(groupIndex: number, index: number, direction: number) {
    if (index === -1) {
      [groups[groupIndex], groups[groupIndex + direction]] = [groups[groupIndex + direction], groups[groupIndex]];
    } else {
      const items = groups[groupIndex][1];
      [items[index], items[index + direction]] = [items[index + direction], items[index]];
    }
    setFields(groups.flatMap(([, items]) => items));
    onDirty();
  }
  function add(group: string) {
    const next = newField(group);
    setFields([...fields, next]);
    setSelected(next.key);
    onDirty();
  }
  function remove() {
    const next = fields.filter((item) => item.key !== field.key).map((item) =>
      item.auto_from === field.key ? { ...item, auto_from: "" } : item);
    setFields(next);
    setSelected(next[Math.min(fields.indexOf(field), next.length - 1)].key);
    onDirty();
  }
  return <form className="inspection-editor" onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    const invalid = fields.find((item) => !item.label.trim() || !item.group.trim());
    if (invalid) {
      setSelected(invalid.key);
      setPreview(false);
      setError("请填写检测项名称和分组");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await save({ name, serial_mode: mode, revision: template?.revision, fields });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <section className="panel inspection-editor-main">
      <label>检测表名称<input required maxLength={80} value={name} onChange={(e) => { setName(e.target.value); onDirty(); }} /></label>
      <label>编号规则<select value={mode} onChange={(e) => { setMode(e.target.value as SerialMode); onDirty(); }}>
        <option value="text">通用 S/N</option>
        <option value="dated">16 位数字（前 6 位＋日期＋尾号）</option>
      </select></label>
    </section>
    <div className="inspection-editor-tools">
      <button type="button" className={action} aria-pressed={!preview} onClick={() => setPreview(false)}>配置检测项</button>
      <button type="button" className={action} aria-pressed={preview} onClick={() => {
        setSample({});
        setPreview(true);
      }}>预览录入</button>
    </div>
    {preview ? <div className="inspection-preview" onKeyDown={(event) => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
      <InspectionFields form={{ id: "preview", name, serial_mode: mode, fields, revision: 1 }}
        values={sample} onChange={(key, value) => setSample((previous) => withValue(previous, key, value))} />
      <ResultLabel value={decision(fields, automaticValues(fields, sample))} />
    </div> : <div className="inspection-editor-layout">
      <section className="panel inspection-editor-nav" aria-label="检测项列表">
        {groups.map(([group, items], groupIndex) => <div className="inspection-editor-section" key={group}>
          <div className="inspection-editor-group">
            <strong>{group}</strong>
            <button type="button" className="icon-btn" title="分组上移" aria-label={group + " 分组上移"}
              disabled={groupIndex === 0} onClick={() => move(groupIndex, -1, -1)}><ArrowUp size={15} /></button>
            <button type="button" className="icon-btn" title="分组下移" aria-label={group + " 分组下移"}
              disabled={groupIndex === groups.length - 1} onClick={() => move(groupIndex, -1, 1)}><ArrowDown size={15} /></button>
            <button type="button" className="icon-btn" title="添加检测项" aria-label={group + " 添加检测项"}
              disabled={fields.length >= 60} onClick={() => add(group)}><Plus size={16} /></button>
          </div>
          {items.map((item) => <button key={item.key} type="button" className="inspection-editor-item"
            aria-pressed={item.key === field.key} onClick={() => setSelected(item.key)}>
            <span>{item.label || "新检测项"}</span>
            <small>{item.auto_from ? "自动判定" : fieldTypes.find(([type]) => type === item.type)?.[1]}</small>
          </button>)}
        </div>)}
        <button type="button" className={action} disabled={fields.length >= 60} onClick={() => {
          let group = "新分组";
          for (let i = 2; fields.some((item) => item.group === group); i++) group = "新分组 " + i;
          add(group);
        }}><Plus size={16} />添加分组</button>
      </section>
      <section className="panel inspection-config-field">
        <div className="inspection-config-head">
          <h3>{field.label || "新检测项"}</h3>
          <div>
            <button type="button" className="btn small" disabled={fieldIndex === 0}
              onClick={() => move(fieldGroup, fieldIndex, -1)}>上移</button>
            <button type="button" className="btn small" disabled={fieldIndex === groupItems.length - 1}
              onClick={() => move(fieldGroup, fieldIndex, 1)}>下移</button>
            <button type="button" className="btn small" disabled={fields.length === 1} onClick={remove}>移除</button>
          </div>
        </div>
        <FieldSettings key={field.key} field={field} fields={fields} update={update} />
      </section>
    </div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="inspection-edit-actions">
      <button type="button" className={action} disabled={busy} onClick={cancel}>取消</button>
      <button className={primary} type="submit" disabled={busy}>{busy ? "保存中…" : "保存检测表"}</button>
    </div>
  </form>;
}

function InspectionImport({ template, request, baseUrl, onImported }: {
  template: Template; request: Request; baseUrl: string; onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(commit: boolean) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("template", template.id);
      if (commit && report) form.append("revision", String(report.revision));
      setReport(await request(inspectionPath + (commit ? "import" : "import-preview"), "POST", form));
      if (commit) {
        setCompleted(true);
        onImported();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <button className={action} type="button" onClick={() => setOpen((value) => !value)}
        aria-expanded={open}><Upload size={16} />导入数据</button>
      {open && <section className="panel inspection-import-panel" aria-label="导入生产检测">
        <div className="inspection-import-actions">
          <a className={action} href={baseUrl + inspectionPath + "import-template?" + parameters(template.id)}>
            <Download size={16} />下载 Excel 模板
          </a>
          <input type="file" accept=".xlsx,.csv" aria-label="检测数据文件" disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setReport(null);
              setError("");
              setCompleted(false);
            }} />
          <button className={action} type="button" disabled={!file || busy} onClick={() => void upload(false)}>预览导入</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {report && <div className="inspection-import-report" aria-live="polite">
          <p>{completed ? "已导入" : "可导入"} <strong>{report.ready}</strong> 条 · 跳过重复 {report.duplicates} 条 · 无效 {report.invalid} 条</p>
          {!!report.ignored.length && <p className="muted">未匹配的列：{report.ignored.join("、")}</p>}
          {!!report.errors.length && <ul>{report.errors.map((item) =>
            <li key={item.row}>第 {item.row} 行：{item.error}</li>)}</ul>}
          {!completed && !!report.sample.length && <p className="muted">
            {report.sample.map((item) => item.serial + "（" + item.result + "）").join("、")}
          </p>}
          {!completed && report.ready > 0 && <button className={primary} type="button" disabled={busy}
            onClick={() => void upload(true)}>确认导入 {report.ready} 条</button>}
        </div>}
      </section>}
    </>
  );
}

function InspectionRecordDetails({ record, request, close }: { record: RecordRow; request: Request; close: () => void }) {
  const [shipments, setShipments] = useState<{
    reference: string; channel: string; shipped_on: string; tracking: string; backer: string | null;
  }[]>([]);
  useEffect(() => {
    let active = true;
    request("shipping/device-records?" + new URLSearchParams({ serial: record.serial })).then(
      (rows) => { if (active) setShipments(rows); }, () => {},
    );
    return () => { active = false; };
  }, [record.serial]);
  return createPortal(
    <Dialog title="检测记录明细" wide onClose={close}>
      <div className="inspection-record-summary">
        <div><span>S/N</span> <strong className="mono">{record.serial}</strong></div>
        <ResultLabel value={record.result} />
      </div>
      <dl className="inspection-detail-grid inspection-detail-meta">
        <div><dt>检测表</dt><dd>{record.form.name}</dd></div>
        <div><dt>生产日期</dt><dd>{record.production_date || "—"}</dd></div>
        <div><dt>检测员</dt><dd>{record.operator_name || "—"}</dd></div>
        <div><dt>创建时间</dt><dd>{formatTime(record.created_at)}</dd></div>
        <div><dt>更新时间</dt><dd>{formatTime(record.updated_at)}</dd></div>
        {record.source_id && <div><dt>原记录 ID</dt><dd>{record.source_id}</dd></div>}
        {record.deleted_at && <div><dt>删除时间</dt><dd>{formatTime(record.deleted_at)}</dd></div>}
      </dl>
      {!!shipments.length && <section className="inspection-detail-group">
        <h3>关联发货</h3>
        <ul className="shipping-device-detail">{shipments.map((item, index) => (
          <li key={index}><span>{item.channel === "ks" ? "KS" : "其他"} · {item.reference}
            {item.backer && " · Backer #" + item.backer}</span>
            <small>{[item.shipped_on, item.tracking].filter(Boolean).join(" · ")}</small></li>
        ))}</ul>
      </section>}
      {sections(record.form.fields).map(([group, fields]) => (
        <section className="inspection-detail-group" key={group}>
          <h3>{group}</h3>
          <dl className="inspection-detail-grid">
            {fields.map((field) => {
              const value = record.values[field.key];
              const text = Array.isArray(value) ? value.join("、") : value;
              return <div key={field.key} className={field.type === "multi" || field.type === "text" ? "wide-field" : ""}>
                <dt>{field.label}</dt>
                <dd>{field.type === "choice" && (text === "OK" || text === "NG")
                  ? <ResultLabel value={text} />
                  : text === undefined || text === "" ? "—" : <>{text}{field.unit && " " + field.unit}</>}</dd>
              </div>;
            })}
          </dl>
        </section>
      ))}
    </Dialog>,
    document.body,
  );
}

function InspectionHistory({ template, request, baseUrl, readOnly, admin, prefix, onImported, revision }: {
  template: Template;
  request: Request;
  baseUrl: string;
  readOnly: boolean;
  admin: boolean;
  prefix: string;
  onImported: () => void;
  revision: number;
}) {
  const [draft, setDraft] = useState<Filters>({ ...defaultFilters, prefix });
  const [filters, setFilters] = useState<Filters>({ ...defaultFilters, prefix });
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [sort, setSort] = useState({ key: "updated_at", direction: "desc" });
  const [deleted, setDeleted] = useState(false);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<RecordPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [pending, setPending] = useState("");
  const [openedRecord, setOpenedRecord] = useState<RecordRow | null>(null);
  const query = parameters(template.id, {
    ...filters, per_page: String(perPage), sort: sort.key, direction: sort.direction,
    deleted: deleted ? "1" : "", page: String(page),
  });
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    request(inspectionPath + "records?" + query).then(
      (response) => { if (active) setData(response); },
      (error) => { if (active) setError(error.message); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [query, reload, revision]);
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / perPage));
  const change = (key: keyof Filters, value: string) => setDraft((previous) => ({ ...previous, [key]: value }));
  const columns = new Map(template.fields.map((field) => [field.key, field.label]));
  for (const row of data?.records || [])
    for (const field of row.form.fields)
      if (!columns.has(field.key)) columns.set(field.key, field.label);
  function sortHeader(key: string, label: string) {
    return <th aria-sort={sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
      <button type="button" className="text-link" onClick={() => {
        setSort({ key, direction: sort.key === key && sort.direction === "desc" ? "asc" : "desc" });
        setPage(1);
      }}>{label}{sort.key === key ? sort.direction === "asc" ? " ↑" : " ↓" : ""}</button>
    </th>;
  }
  async function updateDeleted(record: RecordRow) {
    if (pending || !window.confirm(deleted ? "恢复此检测记录？" : "删除检测记录 " + record.serial + "？")) return;
    setPending(record.id);
    setError("");
    try {
      await request(inspectionPath + "records/" + record.id + (deleted ? "/recover" : ""),
        deleted ? "POST" : "DELETE");
      setPage(1);
      setReload((value) => value + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(""); }
  }
  const exportUrl = baseUrl + inspectionPath + "export?" + query;
  return (
    <section className="inspection-history">
      <div className="inspection-history-tools">
        <button className={action} type="button" onClick={() => setReload((value) => value + 1)}>刷新</button>
        {admin && <button className={action} type="button" aria-pressed={deleted} onClick={() => {
          setData(null);
          setDeleted((value) => !value);
          setPage(1);
        }}>{deleted ? "返回有效记录" : "已删除记录"}</button>}
        {!deleted && <>
          {admin && !readOnly && <InspectionImport template={template} request={request} baseUrl={baseUrl}
            onImported={() => { setPage(1); onImported(); }} />}
          <a className={action} href={exportUrl + "&scope=page"}>
            <Download size={16} />导出当前页
          </a>
          <a className={action} href={exportUrl + "&format=xlsx"}>导出筛选结果（Excel）</a>
          <a className={action} href={exportUrl + "&format=csv"}>导出 CSV</a>
        </>}
      </div>
      <form className="panel inspection-filters" onSubmit={(event) => {
        event.preventDefault();
        setPage(1);
        setFilters({ ...draft });
      }}>
        <label>关键词<input value={draft.keyword} onChange={(e) => change("keyword", e.target.value)} /></label>
        <label>S/N<input value={draft.serial} onChange={(e) => change("serial", e.target.value)} /></label>
        <label>前 6 位<input maxLength={6} value={draft.prefix} onChange={(e) => change("prefix", e.target.value)} /></label>
        <label>起始前缀<input maxLength={6} value={draft.prefix_from} onChange={(e) => change("prefix_from", e.target.value)} /></label>
        <label>结束前缀<input maxLength={6} value={draft.prefix_to} onChange={(e) => change("prefix_to", e.target.value)} /></label>
        <label>检测结果<select value={draft.result} onChange={(e) => change("result", e.target.value)}>
          <option value="">全部</option>{results.map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>起始日期<input type="date" value={draft.from} onChange={(e) => change("from", e.target.value)} /></label>
        <label>结束日期<input type="date" value={draft.to} onChange={(e) => change("to", e.target.value)} /></label>
        <div className="inspection-filter-actions">
          <button className={primary} type="submit"><Search size={15} />筛选</button>
          <button className={action} type="button" onClick={() => {
            setDraft(defaultFilters);
            setFilters(defaultFilters);
            setPage(1);
          }}>重置</button>
        </div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="table-wrap inspection-record-table" aria-busy={busy}>
        <table>
          <thead><tr>
            {sortHeader("serial", "S/N")}{sortHeader("prefix", "前 6 位")}{sortHeader("production_date", "生产日期")}
            {sortHeader("result", "检测结果")}<th>检测员</th>
            {Array.from(columns, ([key, label]) => <th key={key}>{label}</th>)}
            {sortHeader("updated_at", "更新时间")}
            {admin && !readOnly && <th>操作</th>}
          </tr></thead>
          <tbody>{data?.records.map((record) => (
            <tr key={record.id}>
              <td><button type="button" className="text-link mono" aria-haspopup="dialog"
                onClick={() => setOpenedRecord(record)}>{record.serial}</button></td>
              <td className="mono">{record.prefix}</td><td>{record.production_date || "—"}</td>
              <td><ResultLabel value={record.result} /></td>
              <td>{record.operator_name || "—"}</td>
              {Array.from(columns, ([key]) => {
                const value = record.values[key];
                return <td key={key}>{Array.isArray(value) ? value.join("、") : value ?? "—"}</td>;
              })}
              <td>{formatTime(record.updated_at)}</td>
              {admin && !readOnly && <td><button type="button" className="btn small"
                disabled={!!pending} onClick={() => void updateDeleted(record)}>{deleted ? "恢复" : "删除"}</button></td>}
            </tr>
          ))}</tbody>
        </table>
        {!busy && !error && !data?.records.length && <p className="inspection-no-records">
          {deleted ? "暂无已删除记录" : "暂无检测记录"}</p>}
      </div>
      <div className="inspection-paging">
        <label>每页 <select aria-label="每页记录数" value={perPage} onChange={(event) => {
          setPerPage(Number(event.target.value));
          setPage(1);
        }}>{[20, 50, 100, 200].map((size) => <option key={size}>{size}</option>)}</select></label>
        <span>{busy ? "正在加载…" : "共 " + (data?.total || 0) + " 条"}</span>
        <button type="button" className="btn small" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {totalPages}</span>
        <button type="button" className="btn small" disabled={page >= totalPages || busy} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
      {openedRecord && <InspectionRecordDetails record={openedRecord} request={request} close={() => setOpenedRecord(null)} />}
    </section>
  );
}

function DeviceRegistry({ request, prefix, refresh, readOnly, open, register }: {
  request: Request; prefix: string; refresh: number; readOnly: boolean;
  open: (device: Device) => void; register: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [activePrefix, setActivePrefix] = useState(prefix);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DevicePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ serial: search, page: String(page), prefix: activePrefix });
    request(inspectionPath + "devices?" + query).then(
      (value) => { if (active) setData(value); },
      (e) => { if (active) setError(e.message); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search, page, refresh, activePrefix]);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 50));
  return (
    <section className="inspection-devices">
      <form className="inspection-device-tools" onSubmit={(event) => {
        event.preventDefault();
        setSearch(draft.trim());
        setActivePrefix("");
        setPage(1);
      }}>
        <input aria-label="搜索设备 S/N" placeholder="搜索设备 S/N…" value={draft}
          onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className={action}><Search size={15} />查询</button>
        {!readOnly && <button type="button" className={primary} onClick={register}><Plus size={16} />登记设备</button>}
      </form>
      {activePrefix && <p className="muted">前 6 位：{activePrefix}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="table-wrap" aria-busy={loading}>
        <table>
          <thead><tr><th>S/N</th><th>前 6 位</th><th>生产日期</th><th>检测状态</th><th>检测记录</th>
            <th>登记人</th><th>登记时间</th><th>操作</th></tr></thead>
          <tbody>{data?.devices.map((device) => (
            <tr key={device.serial}>
              <td className="mono">{device.serial}</td><td>{device.prefix}</td>
              <td>{device.production_date || "—"}</td><td><ResultLabel value={device.result || "待检测"} /></td>
              <td>{device.records}</td><td>{device.operator_name || "—"}</td>
              <td>{formatTime(device.registered_at)}</td>
              <td><button type="button" className="text-link" onClick={() => open(device)}>打开设备</button></td>
            </tr>
          ))}</tbody>
        </table>
        {!loading && !error && !data?.devices.length && <p className="inspection-no-records">暂无设备</p>}
      </div>
      {pages > 1 && <div className="inspection-paging">
        <button type="button" className="btn small" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {pages}</span>
        <button type="button" className="btn small" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>下一页</button>
      </div>}
    </section>
  );
}

export function ProductionInspection({ request, baseUrl, admin, readOnly, onDraftChange }: {
  request: Request;
  baseUrl: string;
  admin: boolean;
  readOnly: boolean;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [tab, setTab] = useState<"entry" | "devices" | "history" | "settings">("entry");
  const [editor, setEditor] = useState<Template | null | undefined>(undefined);
  const [copy, setCopy] = useState<Template>();
  const [serial, setSerial] = useState("");
  const [prefix, setPrefix] = useState("");
  const [historyPrefix, setHistoryPrefix] = useState("");
  const [values, setValues] = useState<Values>({});
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [savedOptions, setSavedOptions] = useState<SavedOption[]>([]);
  const [optionSearch, setOptionSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [camera, setCamera] = useState<"live" | "photo" | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [lastResult, setLastResult] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const serialInput = useRef<HTMLInputElement>(null);
  const template = templates.find((item) => item.id === templateId);
  const form = record?.form || template;
  const visibleOptions = savedOptions.filter((item) => {
    const label = template?.fields.find((field) => field.key === item.field_key)?.label || "";
    return (label + " " + item.value).toLowerCase().includes(optionSearch.trim().toLowerCase());
  });

  useEffect(() => {
    let active = true;
    request(inspectionPath + "templates").then(
      (items: Template[]) => {
        if (!active) return;
        setTemplates(items);
        setTemplateId(items[0]?.id || "");
      },
      (error) => { if (active) setError(error.message); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!templateId) {
      setSavedOptions([]);
      return;
    }
    request(inspectionPath + "options?" + parameters(templateId)).then(
      (rows) => { if (active) setSavedOptions(rows); },
      () => { if (active) setSavedOptions([]); },
    );
    return () => { active = false; };
  }, [templateId, revision]);
  useEffect(() => {
    if (!loading && tab === "entry" && !record) serialInput.current?.focus();
  }, [loading, tab]);
  useEffect(() => {
    onDraftChange(dirty || configDirty);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    if (dirty || configDirty) window.addEventListener("beforeunload", warn);
    return () => {
      onDraftChange(false);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, configDirty]);
  function discard() {
    return !(dirty || configDirty) || window.confirm("放弃未保存的检测内容？");
  }
  function clearEntry(focus = false) {
    setRecord(null);
    setDevice(null);
    setSerial("");
    setValues({});
    setDirty(false);
    setError("");
    setNotice("");
    setLastResult("");
    if (focus) requestAnimationFrame(() => serialInput.current?.focus());
  }
  function chooseRecord(row: RecordRow) {
    setRecord(row);
    setSerial(row.serial);
    setValues(row.values);
    setDirty(false);
    setLastResult("");
    setNotice("");
    setError("");
    setTab("entry");
  }
  async function lookup(raw = serial, scanned = false) {
    if (busy || (scanned && !discard())) return;
    const value = template?.serial_mode === "dated" && scanned
      ? (raw.match(/(?<![0-9])[0-9]{16}(?![0-9])/)?.[0] || raw.trim()) : raw.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result: { record?: RecordRow | null; device: Device | null } = await request(template
        ? inspectionPath + "lookup?" + parameters(template.id, { serial: value })
        : inspectionPath + "device?" + new URLSearchParams({ serial: value }));
      if (result.record && dirty && !scanned && !discard()) return;
      if (scanned) {
        setRecord(null);
        setValues({});
        setDirty(false);
      }
      setSerial(value);
      setDevice(result.device);
      setLastResult("");
      if (result.record) {
        chooseRecord(result.record);
        setNotice("已载入此 S/N 的检测记录");
      } else {
        setNotice(result.device ? "设备已登记" : "新 S/N，可登记设备");
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function registerDevice() {
    if (busy || readOnly || !serial.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response: { device: Device; created: boolean } = await request(
        inspectionPath + "devices", "POST", { serial, template_id: template?.id },
      );
      setDevice(response.device);
      setSerial(response.device.serial);
      setNotice(response.created ? "已登记设备 " + response.device.serial : "该设备已登记");
      setRevision((value) => value + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function queryLatest() {
    const value = prefix.trim();
    if (value.length !== 6 || busy) return;
    if (!template) {
      setHistoryPrefix(value);
      changeTab("devices");
      return;
    }
    if (!discard()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result: { record: RecordRow | null } = await request(
        inspectionPath + "latest?" + parameters(template.id, { prefix: value }),
      );
      if (result.record) {
        setDevice(null);
        chooseRecord(result.record);
        setNotice("已载入前缀 " + value + " 的最近检测记录");
      } else setNotice("未找到该前缀的检测记录");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function saveRecord() {
    if (!template || !form || !serial.trim() || busy || readOnly) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const saved: RecordRow = await request(inspectionPath + "records", "POST", {
        template_id: template.id, serial, values, version: record?.updated_at || null, revision: form.revision,
      });
      clearEntry(true);
      setLastResult(saved.result);
      setNotice("已保存 " + saved.serial + " · " + saved.result + "，可继续扫码");
      setRevision((value) => value + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function changeTab(next: typeof tab) {
    if (configDirty && !discard()) return;
    if (configDirty) setConfigDirty(false);
    if (next !== "settings") {
      setEditor(undefined);
      setCopy(undefined);
    }
    setError("");
    setTab(next);
  }
  if (loading) return <p className="muted">正在加载生产检测…</p>;
  return (
    <div className="inspection-workspace">
      <div className="page-heading inspection-heading">
        <h1>生产检测</h1>
        {!!templates.length && <label className="inspection-template-select">
          检测表
          <select value={templateId} disabled={busy} onChange={(event) => {
            if (!discard()) return;
            setTemplateId(event.target.value);
            setEditor(undefined);
            setCopy(undefined);
            setConfigDirty(false);
            setHistoryPrefix("");
            setRecord(null);
            setValues({});
            setDirty(false);
            setLastResult("");
            setNotice("");
            setError("");
          }}>
            {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
      </div>
      <div className="tabs page-tabs" aria-label="生产检测功能">
        <button type="button" className={tab === "entry" ? "selected" : ""} onClick={() => changeTab("entry")}>检测录入</button>
        <button type="button" className={tab === "devices" ? "selected" : ""} onClick={() => {
          setHistoryPrefix("");
          changeTab("devices");
        }}>设备台账</button>
        <button type="button" className={tab === "history" ? "selected" : ""} onClick={() => changeTab("history")}>检测记录</button>
        {admin && !readOnly && <button type="button" className={tab === "settings" ? "selected" : ""}
          onClick={() => changeTab("settings")}>检测表设置</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!template && tab === "history" && (
        <div className="panel inspection-empty">
          <h3>暂无检测表</h3>
          {admin && !readOnly ? <button type="button" className={primary} onClick={() => {
            setTab("settings");
            setEditor(null);
          }}><Plus size={16} />新建检测表</button> : <p className="muted">请联系管理员设置检测表。</p>}
        </div>
      )}
      {tab === "settings" && admin && !readOnly && (
        editor !== undefined ? <TemplateEditor key={editor?.id || copy?.id || "new"} template={editor} copy={copy}
          onDirty={() => setConfigDirty(true)}
          cancel={() => { if (discard()) { setEditor(undefined); setCopy(undefined); setConfigDirty(false); } }}
          save={async (data) => {
            const saved: Template = await request(inspectionPath + "templates" + (editor ? "/" + editor.id : ""),
              editor ? "PUT" : "POST", data);
            setTemplates((previous) => editor
              ? previous.map((item) => item.id === saved.id ? saved : item) : [...previous, saved]);
            setTemplateId(saved.id);
            setEditor(undefined);
            setCopy(undefined);
            setConfigDirty(false);
            setRecord(null);
            setValues({});
            setDirty(false);
            setTab("entry");
          }} /> : <section className="panel inspection-template-list">
            <div className="inspection-config-head">
              <h3>检测表</h3>
              <button type="button" className={primary} onClick={() => {
                if (discard()) { setDirty(false); setEditor(null); }
              }}><Plus size={16} />新建检测表</button>
            </div>
            {templates.map((item) => <div className="inspection-template-row inspection-template-actions" key={item.id}>
              <strong>{item.name}</strong><span className="muted">{item.fields.length} 项 · 版本 {item.revision}</span>
              <button type="button" className="btn small" onClick={() => {
                if (discard()) { setDirty(false); setEditor(item); }
              }}>编辑</button>
              <button type="button" className="btn small" onClick={() => {
                if (discard()) { setDirty(false); setCopy(item); setEditor(null); }
              }}>复制</button>
            </div>)}
          </section>
      )}
      {tab === "settings" && editor === undefined && template && savedOptions.length > 0 && (
        <section className="panel inspection-site-options">
          <div className="inspection-config-head">
            <h3>现场新增选项 <small className="muted">{savedOptions.length} 项</small></h3>
            <input aria-label="搜索现场选项" placeholder="搜索检测项或选项" value={optionSearch}
              onChange={(event) => setOptionSearch(event.target.value)} />
          </div>
          <div className="inspection-site-option-list">
            {visibleOptions.map((item) => (
              <div className="inspection-template-row" key={item.field_key + ":" + item.value}>
                <span className="muted">{template.fields.find((field) => field.key === item.field_key)?.label}</span>
                <strong>{item.value}</strong>
                <button type="button" className="btn small" disabled={busy} onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setSavedOptions(await request(inspectionPath + "options", "PUT", {
                      template_id: template.id, field_key: item.field_key, value: item.value, hidden: !item.hidden_at,
                    }));
                  } catch (e) { setError((e as Error).message); }
                  finally { setBusy(false); }
                }}>{item.hidden_at ? "恢复选项" : "隐藏选项"}</button>
              </div>
            ))}
            {!visibleOptions.length && <p className="muted">无匹配选项</p>}
          </div>
        </section>
      )}
      {tab === "devices" && <DeviceRegistry key={historyPrefix} request={request} prefix={historyPrefix}
        refresh={revision} readOnly={readOnly} open={(item) => {
          if (!discard()) return;
          clearEntry(true);
          setDevice(item);
          setSerial(item.serial);
          setTab("entry");
        }} register={() => {
          if (!discard()) return;
          clearEntry(true);
          setTab("entry");
        }} />}
      {template && tab === "history" && <InspectionHistory key={template.id + ":" + historyPrefix}
        template={template} request={request} baseUrl={baseUrl} readOnly={readOnly} admin={admin}
        onImported={() => setRevision((value) => value + 1)}
        prefix={historyPrefix} revision={revision} />}
      {tab === "entry" && (
        <>
          <form className="panel inspection-sn" onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
            <h2>设备登记</h2>
            <div className="inspection-sn-row">
              <label>S/N
                <input ref={serialInput} autoComplete="off" inputMode={form?.serial_mode === "dated" ? "numeric" : "text"}
                  maxLength={form?.serial_mode === "dated" ? 16 : 100} placeholder="扫码枪输入或手动输入"
                  readOnly={!!record} disabled={busy} value={serial}
                  onChange={(event) => { setSerial(event.target.value); setDevice(null); setNotice(""); setLastResult(""); }} />
              </label>
              <button type="submit" className={action} disabled={busy || !serial.trim()}>读取记录</button>
              <button type="button" className={action} disabled={busy} onClick={() => setCamera("live")}>
                <Camera size={16} />摄像头扫码
              </button>
              <button type="button" className={action} disabled={busy}
                onClick={() => setCamera("photo")}>从照片识别</button>
              {!readOnly && <button type="button" className={primary}
                disabled={busy || !serial.trim() || !!device || !!record}
                onClick={() => void registerDevice()}>登记设备</button>}
            </div>
            <div className="inspection-serial-info">
              <span>前 6 位 <b>{serial.slice(0, 6) || "—"}</b></span>
              {(form?.serial_mode === "dated" || device?.production_date) && <>
                <span>生产日期 <b>{record?.production_date || device?.production_date || (serial.length === 16
                  ? (Number(serial.slice(6, 8)) >= 69 ? "19" : "20") + serial.slice(6, 8) + "-" + serial.slice(8, 10) + "-" + serial.slice(10, 12)
                  : "—")}</b></span>
                <span>尾号 <b>{serial.length === 16 ? serial.slice(12) : "—"}</b></span>
              </>}
              {record && <span>最近检测 <b>{formatTime(record.updated_at)}</b></span>}
              {(device || record) && <span className="inspection-registered">已登记</span>}
            </div>
          </form>
          <form className="inspection-prefix" onSubmit={(event) => {
            event.preventDefault();
            void queryLatest();
          }}>
            <input aria-label="按前 6 位查询" placeholder="按前 6 位查询历史记录" maxLength={6} value={prefix}
              onChange={(event) => setPrefix(event.target.value)} />
            <button className={action} type="submit" disabled={busy || prefix.trim().length !== 6}>
              <Search size={15} />{template ? "查最近一条" : "查设备"}
            </button>
            {template && <button type="button" className={action} disabled={prefix.trim().length !== 6}
              onClick={() => { setHistoryPrefix(prefix.trim()); changeTab("history"); }}>查看全部</button>}
          </form>
          {notice && <p className="inspection-notice" role="status">
            {lastResult && <ResultLabel value={lastResult} />}{notice}
          </p>}
          {!form && <section className="panel inspection-empty">
            <h3>暂无检测表</h3>
            {admin && !readOnly ? <button type="button" className={action} onClick={() => {
              setTab("settings");
              setEditor(null);
            }}><Plus size={16} />新建检测表</button> : <p className="muted">请联系管理员配置检测表。</p>}
          </section>}
          {form && <fieldset className="inspection-entry-fields" disabled={readOnly || busy}>
            <InspectionFields key={serial && (record?.id || "new")} form={form} values={values}
              original={record?.values} savedOptions={savedOptions} onChange={(key, value) => {
                setValues((previous) => withValue(previous, key, value));
                setDirty(true);
              }} />
          </fieldset>}
          <div className="inspection-submit">
            <div>{form && (!lastResult || serial) &&
              <ResultLabel value={record && !dirty ? record.result :
                decision(form.fields, automaticValues(form.fields, values, record?.values))} />}</div>
            <div>
              <button type="button" className={action} disabled={busy} onClick={() => {
                if (discard()) clearEntry(true);
              }}>{record || device ? "下一台" : "清空表单"}</button>
              {form && !readOnly && <button type="button" className={primary} disabled={busy || !serial.trim() || (!!record && !dirty)}
                onClick={() => void saveRecord()}>{busy ? "处理中…" : "保存检测"}</button>}
            </div>
          </div>
          {camera && <CameraReader live={camera === "live"} close={() => setCamera(null)} onRead={(value) => {
            setCamera(null);
            void lookup(value, true);
          }} />}
        </>
      )}
    </div>
  );
}

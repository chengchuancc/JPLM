import { useEffect, useRef, useState } from "react";
import { Camera, Download, Plus, Search, Upload, X } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
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
  updated_at: string;
  values: Values;
  form: Template;
};
type RecordPage = { records: RecordRow[]; total: number; page: number };
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
type Filters = { serial: string; prefix: string; result: string; from: string; to: string };
const defaultFilters: Filters = { serial: "", prefix: "", result: "", from: "", to: "" };
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
      if ((field.minimum !== null && numeric < field.minimum) ||
          (field.maximum !== null && numeric > field.maximum)) return "不良";
    } else if ((Array.isArray(value) ? value : [String(value)]).some((choice) => field.fail.includes(choice))) {
      return "不良";
    }
  }
  return incomplete || !Object.keys(values).length ? "未完成" : "合格";
}

function ResultLabel({ value }: { value: string }) {
  const tone = value === "不良" ? "fail" : value === "合格" ? "pass" : "pending";
  return <span className={"inspection-result " + tone}>{value}</span>;
}

function CameraReader({ live, onRead, close }: {
  live: boolean; onRead: (value: string) => void; close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const read = useRef(onRead);
  read.current = onRead;
  const [facing, setFacing] = useState<"environment" | "user">("environment");
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
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("当前浏览器无法打开摄像头，可以选择条码照片。");
      return;
    }
    void import("@zxing/browser").then(async ({ BrowserMultiFormatReader }) => {
      if (!active) return;
      const reader = new BrowserMultiFormatReader();
      controls = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 } } },
        element,
        (result, _error, session) => {
          if (!active || !result) return;
          active = false;
          session.stop();
          read.current(result.getText());
        },
      );
      if (!active) controls.stop();
    }).catch(() => {
      if (active) setMessage("无法打开摄像头。请检查浏览器权限，或选择条码照片。");
    });
    return () => {
      active = false;
      controls?.stop();
      if (element.srcObject instanceof MediaStream)
        element.srcObject.getTracks().forEach((track) => track.stop());
    };
  }, [facing, live]);

  async function scanPhoto(file?: File) {
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
          {live && <button type="button" className={action} onClick={() =>
            setFacing((value) => value === "environment" ? "user" : "environment")}>切换摄像头</button>}
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

function FieldInput({ field, value, onChange }: {
  field: InspectionField;
  value?: Value;
  onChange: (value: Value | undefined) => void;
}) {
  const [custom, setCustom] = useState("");
  const selected = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
  const options = Array.from(new Set([...field.options, ...selected]));
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : null;
  const hasLimit = field.minimum !== null || field.maximum !== null;
  const failed = numeric !== null &&
    ((field.minimum !== null && numeric < field.minimum) || (field.maximum !== null && numeric > field.maximum));
  function addChoice() {
    const entered = custom.trim();
    if (!entered) return;
    onChange(Array.from(new Set([...selected, entered])));
    setCustom("");
  }
  return (
    <fieldset className="inspection-field">
      <legend>{field.label}{field.required && <span className="required"> *</span>}</legend>
      {(field.type === "choice" || field.type === "multi") ? (
        <>
          <div className="inspection-choices">
            {options.map((option) => (
              <button key={option} type="button"
                className={"inspection-choice" + (field.fail.includes(option) ? " is-fail" : "")}
                aria-pressed={selected.includes(option)} onClick={() => {
                  if (field.type === "choice") onChange(value === option ? undefined : option);
                  else onChange(selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option]);
                }}>
                {option}
              </button>
            ))}
          </div>
          {field.custom && <div className="inspection-custom">
            <input aria-label={field.label + " 自定义选项"} placeholder="其他选项…" maxLength={250} value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addChoice(); } }} />
            <button type="button" className="btn small" disabled={!custom.trim()} onClick={addChoice}>添加</button>
          </div>}
        </>
      ) : field.type === "number" ? (
        <>
          <div className="inspection-measurement">
            <input type="number" step="any" aria-label={field.label} value={value === undefined ? "" : String(value)}
              onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)} />
            {field.unit && <span>{field.unit}</span>}
            {hasLimit && numeric !== null && <span className={"inspection-result " + (failed ? "fail" : "pass")}>
              {failed ? "NG" : "OK"}
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

type EditableField = Omit<InspectionField, "options" | "fail" | "minimum" | "maximum"> & {
  options: string; fail: string; minimum: string; maximum: string;
};
function editable(field: InspectionField): EditableField {
  return { ...field, options: field.options.join("\n"), fail: field.fail.join("\n"),
    minimum: field.minimum?.toString() || "", maximum: field.maximum?.toString() || "" };
}
function newField(label = "", type: FieldType = "choice"): EditableField {
  return {
    key: "field_" + crypto.randomUUID().replaceAll("-", ""), label, group: "检测项", type,
    options: "OK\nNG", fail: "NG", minimum: "", maximum: "", unit: "", custom: false, required: true,
  };
}
const fieldTypes: [FieldType, string][] = [["choice", "单选"], ["multi", "多选"], ["number", "数值"], ["text", "文本"]];
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

function TemplateEditor({ template, save, cancel, onDirty }: {
  template: Template | null; save: (data: unknown) => Promise<void>; cancel: () => void;
  onDirty: () => void;
}) {
  const [name, setName] = useState(template?.name || "出厂检测");
  const [mode, setMode] = useState<SerialMode>(template?.serial_mode || "text");
  const [fields, setFields] = useState<EditableField[]>(() => template ? template.fields.map(editable) :
    [newField("功能检测"), newField("外观检测"), { ...newField("备注", "text"), required: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, patch: Partial<EditableField>) =>
    setFields((previous) => previous.map((field) => field.key === key ? { ...field, ...patch } : field));
  function move(index: number, direction: number) {
    setFields((previous) => {
      const next = [...previous];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
    onDirty();
  }
  return (
    <form className="inspection-editor" onChange={onDirty} onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await save({
          name, serial_mode: mode, revision: template?.revision,
          fields: fields.map((field) => ({ ...field, options: lines(field.options), fail: lines(field.fail) })),
        });
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      <section className="panel inspection-editor-main">
        <label>检测表名称<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>编号规则<select value={mode} onChange={(e) => setMode(e.target.value as SerialMode)}>
          <option value="text">通用 S/N</option>
          <option value="dated">16 位数字（前 6 位＋日期＋尾号）</option>
        </select></label>
      </section>
      {fields.map((field, index) => (
        <section className="panel inspection-config-field" key={field.key}>
          <div className="inspection-config-head">
            <h3>{index + 1}. {field.label || "检测项"}</h3>
            <div>
              <button type="button" className="btn small" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
              <button type="button" className="btn small" disabled={index === fields.length - 1} onClick={() => move(index, 1)}>下移</button>
              <button type="button" className="btn small" disabled={fields.length === 1} onClick={() => {
                setFields((previous) => previous.filter((item) => item.key !== field.key));
                onDirty();
              }}>移除</button>
            </div>
          </div>
          <div className="inspection-config-grid">
            <label>检测项名称<input required maxLength={80} value={field.label}
              onChange={(e) => update(field.key, { label: e.target.value })} /></label>
            <label>分组<input maxLength={60} value={field.group}
              onChange={(e) => update(field.key, { group: e.target.value })} /></label>
            <label>类型<select value={field.type} onChange={(e) => update(field.key, { type: e.target.value as FieldType })}>
              {fieldTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            {field.type === "number" && <>
              <label>单位<input value={field.unit} maxLength={24} onChange={(e) => update(field.key, { unit: e.target.value })} /></label>
              <label>合格下限<input type="number" step="any" value={field.minimum}
                onChange={(e) => update(field.key, { minimum: e.target.value })} /></label>
              <label>合格上限<input type="number" step="any" value={field.maximum}
                onChange={(e) => update(field.key, { maximum: e.target.value })} /></label>
            </>}
          </div>
          {(field.type === "choice" || field.type === "multi") && <div className="inspection-editor-main">
            <label>选项（每行一个）<textarea rows={3} value={field.options}
              onChange={(e) => update(field.key, { options: e.target.value })} /></label>
            <label>判为不良的选项（每行一个）<textarea rows={3} value={field.fail}
              onChange={(e) => update(field.key, { fail: e.target.value })} /></label>
          </div>}
          <div className="inspection-checks">
            <label><input type="checkbox" checked={field.required}
              onChange={(e) => update(field.key, { required: e.target.checked })} />必检项</label>
            {field.type === "multi" && <label><input type="checkbox" checked={field.custom}
              onChange={(e) => update(field.key, { custom: e.target.checked })} />允许现场添加选项</label>}
          </div>
        </section>
      ))}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="inspection-edit-actions">
        <button type="button" className={action} disabled={fields.length >= 60} onClick={() => {
          setFields((previous) => [...previous, newField()]);
          onDirty();
        }}><Plus size={16} />添加检测项</button>
        <button type="button" className={action} onClick={cancel}>取消</button>
        <button className={primary} type="submit" disabled={busy}>{busy ? "保存中…" : "保存检测表"}</button>
      </div>
    </form>
  );
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

function InspectionHistory({ template, request, baseUrl, readOnly, admin, prefix, onChoose, revision }: {
  template: Template;
  request: Request;
  baseUrl: string;
  readOnly: boolean;
  admin: boolean;
  prefix: string;
  onChoose: (row: RecordRow) => void;
  revision: number;
}) {
  const [draft, setDraft] = useState<Filters>({ ...defaultFilters, prefix });
  const [filters, setFilters] = useState<Filters>({ ...defaultFilters, prefix });
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<RecordPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const query = parameters(template.id, filters);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    request(inspectionPath + "records?" + query + "&page=" + page).then(
      (response) => { if (active) setData(response); },
      (error) => { if (active) setError(error.message); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [query, page, reload, revision]);
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / 50));
  const change = (key: keyof Filters, value: string) => setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <section className="inspection-history">
      <div className="inspection-history-tools">
        {admin && !readOnly && <InspectionImport template={template} request={request} baseUrl={baseUrl}
          onImported={() => { setPage(1); setReload((value) => value + 1); }} />}
        <a className={action} href={baseUrl + inspectionPath + "export?" + query + "&format=xlsx"}>
          <Download size={16} />导出 Excel
        </a>
        <a className={action} href={baseUrl + inspectionPath + "export?" + query + "&format=csv"}>导出 CSV</a>
      </div>
      <form className="panel inspection-filters" onSubmit={(event) => {
        event.preventDefault();
        setPage(1);
        setFilters({ ...draft });
      }}>
        <label>S/N<input value={draft.serial} onChange={(e) => change("serial", e.target.value)} /></label>
        <label>前 6 位<input maxLength={6} value={draft.prefix} onChange={(e) => change("prefix", e.target.value)} /></label>
        <label>检测结果<select value={draft.result} onChange={(e) => change("result", e.target.value)}>
          <option value="">全部</option>{results.map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>起始日期<input type="date" value={draft.from} onChange={(e) => change("from", e.target.value)} /></label>
        <label>结束日期<input type="date" value={draft.to} onChange={(e) => change("to", e.target.value)} /></label>
        <button className={primary} type="submit"><Search size={15} />筛选</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="table-wrap" aria-busy={busy}>
        <table>
          <thead><tr><th>S/N</th><th>前 6 位</th><th>生产日期</th><th>检测结果</th><th>检测员</th><th>更新时间</th></tr></thead>
          <tbody>{data?.records.map((record) => (
            <tr key={record.id}>
              <td><button type="button" className="text-link mono" onClick={() => onChoose(record)}>{record.serial}</button></td>
              <td className="mono">{record.prefix}</td><td>{record.production_date || "—"}</td>
              <td><ResultLabel value={record.result} /></td>
              <td>{record.operator_name || "—"}</td><td>{formatTime(record.updated_at)}</td>
            </tr>
          ))}</tbody>
        </table>
        {!busy && !error && !data?.records.length && <p className="inspection-no-records">暂无检测记录</p>}
      </div>
      <div className="inspection-paging">
        <span>{busy ? "正在加载…" : "共 " + (data?.total || 0) + " 条"}</span>
        <button type="button" className="btn small" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {totalPages}</span>
        <button type="button" className="btn small" disabled={page >= totalPages || busy} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
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
  const [tab, setTab] = useState<"entry" | "history" | "settings">("entry");
  const [editor, setEditor] = useState<Template | null | undefined>(undefined);
  const [serial, setSerial] = useState("");
  const [prefix, setPrefix] = useState("");
  const [historyPrefix, setHistoryPrefix] = useState("");
  const [values, setValues] = useState<Values>({});
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [camera, setCamera] = useState<"live" | "photo" | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const serialInput = useRef<HTMLInputElement>(null);
  const template = templates.find((item) => item.id === templateId);
  const form = record?.form || template;
  const groups = new Map<string, InspectionField[]>();
  for (const field of form?.fields || []) {
    groups.set(field.group, [...(groups.get(field.group) || []), field]);
  }

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
    setSerial("");
    setValues({});
    setDirty(false);
    setError("");
    setNotice("");
    if (focus) requestAnimationFrame(() => serialInput.current?.focus());
  }
  function chooseRecord(row: RecordRow) {
    setRecord(row);
    setSerial(row.serial);
    setValues(row.values);
    setDirty(false);
    setNotice("");
    setError("");
    setTab("entry");
  }
  async function lookup(raw = serial, scanned = false) {
    if (!template || busy) return;
    const value = template.serial_mode === "dated" && scanned
      ? (raw.match(/(?<![0-9])[0-9]{16}(?![0-9])/)?.[0] || raw.trim()) : raw.trim();
    if (!value) return;
    setSerial(value);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result: { record: RecordRow | null } = await request(
        inspectionPath + "lookup?" + parameters(template.id, { serial: value }),
      );
      if (result.record) {
        if (dirty && !discard()) return;
        chooseRecord(result.record);
        setNotice("已载入此 S/N 的检测记录");
      } else {
        setNotice("新 S/N，可以开始检测");
      }
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
      chooseRecord(saved);
      setNotice("已保存 " + saved.serial + " · " + saved.result);
      setRevision((value) => value + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function changeTab(next: typeof tab) {
    if (configDirty && !discard()) return;
    if (configDirty) setConfigDirty(false);
    if (next !== "settings") setEditor(undefined);
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
            setConfigDirty(false);
            setHistoryPrefix("");
            clearEntry();
          }}>
            {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
      </div>
      <div className="tabs page-tabs" aria-label="生产检测功能">
        <button type="button" className={tab === "entry" ? "selected" : ""} onClick={() => changeTab("entry")}>检测录入</button>
        <button type="button" className={tab === "history" ? "selected" : ""} onClick={() => changeTab("history")}>检测记录</button>
        {admin && !readOnly && <button type="button" className={tab === "settings" ? "selected" : ""}
          onClick={() => changeTab("settings")}>检测表设置</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!template && tab !== "settings" && (
        <div className="panel inspection-empty">
          <h3>暂无检测表</h3>
          {admin && !readOnly ? <button type="button" className={primary} onClick={() => {
            setTab("settings");
            setEditor(null);
          }}><Plus size={16} />新建检测表</button> : <p className="muted">请联系管理员设置检测表。</p>}
        </div>
      )}
      {tab === "settings" && admin && !readOnly && (
        editor !== undefined ? <TemplateEditor key={editor?.id || "new"} template={editor}
          onDirty={() => setConfigDirty(true)}
          cancel={() => { if (discard()) { setEditor(undefined); setConfigDirty(false); } }}
          save={async (data) => {
            const saved: Template = await request(inspectionPath + "templates" + (editor ? "/" + editor.id : ""),
              editor ? "PUT" : "POST", data);
            setTemplates((previous) => editor
              ? previous.map((item) => item.id === saved.id ? saved : item) : [...previous, saved]);
            setTemplateId(saved.id);
            setEditor(undefined);
            setConfigDirty(false);
            clearEntry();
          }} /> : <section className="panel inspection-template-list">
            <div className="inspection-config-head">
              <h3>检测表</h3>
              <button type="button" className={primary} onClick={() => {
                if (discard()) { clearEntry(); setEditor(null); }
              }}><Plus size={16} />新建检测表</button>
            </div>
            {templates.map((item) => <div className="inspection-template-row" key={item.id}>
              <strong>{item.name}</strong><span className="muted">{item.fields.length} 项 · 版本 {item.revision}</span>
              <button type="button" className="btn small" onClick={() => {
                if (discard()) { clearEntry(); setEditor(item); }
              }}>编辑</button>
            </div>)}
          </section>
      )}
      {template && tab === "history" && <InspectionHistory key={template.id + ":" + historyPrefix}
        template={template} request={request} baseUrl={baseUrl} readOnly={readOnly} admin={admin}
        prefix={historyPrefix} revision={revision} onChoose={(row) => { if (discard()) chooseRecord(row); }} />}
      {template && form && tab === "entry" && (
        <>
          <form className="panel inspection-sn" onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
            <div className="inspection-sn-row">
              <label>S/N
                <input ref={serialInput} autoComplete="off" inputMode={form.serial_mode === "dated" ? "numeric" : "text"}
                  maxLength={form.serial_mode === "dated" ? 16 : 100} placeholder="扫码枪输入或手动输入"
                  readOnly={!!record} disabled={busy} value={serial}
                  onChange={(event) => { setSerial(event.target.value); setNotice(""); }} />
              </label>
              <button type="submit" className={action} disabled={busy || !!record || !serial.trim()}>读取记录</button>
              <button type="button" className={action} disabled={busy || !!record} onClick={() => setCamera("live")}>
                <Camera size={16} />扫码
              </button>
              <button type="button" className={action} disabled={busy || !!record}
                onClick={() => setCamera("photo")}>从照片识别</button>
            </div>
            <div className="inspection-serial-info">
              <span>前 6 位 <b>{serial.slice(0, 6) || "—"}</b></span>
              {form.serial_mode === "dated" && <>
                <span>生产日期 <b>{serial.length === 16 ? "20" + serial.slice(6, 8) + "-" + serial.slice(8, 10) + "-" + serial.slice(10, 12) : "—"}</b></span>
                <span>尾号 <b>{serial.length === 16 ? serial.slice(12) : "—"}</b></span>
              </>}
              {record && <span>最近检测 <b>{formatTime(record.updated_at)}</b></span>}
            </div>
          </form>
          <form className="inspection-prefix" onSubmit={(event) => {
            event.preventDefault();
            setHistoryPrefix(prefix.trim());
            changeTab("history");
          }}>
            <input aria-label="按前 6 位查询" placeholder="按前 6 位查询历史记录" maxLength={6} value={prefix}
              onChange={(event) => setPrefix(event.target.value)} />
            <button className={action} type="submit" disabled={prefix.trim().length !== 6}>
              <Search size={15} />查询历史
            </button>
          </form>
          <fieldset className="inspection-entry-fields" disabled={readOnly || busy}>
            {Array.from(groups, ([group, fields]) => (
              <section className="panel inspection-field-group" key={group}>
                <h3>{group}</h3>
                <div className="inspection-field-grid">
                  {fields.map((field) => <FieldInput key={form.id + ":" + form.revision + ":" + field.key}
                    field={field} value={values[field.key]} onChange={(value) => {
                      setValues((previous) => {
                        const next = { ...previous };
                        if (value === undefined || (Array.isArray(value) && !value.length)) delete next[field.key];
                        else next[field.key] = value;
                        return next;
                      });
                      setDirty(true);
                    }} />)}
                </div>
              </section>
            ))}
          </fieldset>
          <div className="inspection-submit">
            <div><ResultLabel value={record && !dirty ? record.result : decision(form.fields, values)} />
              {notice && <span role="status" className="muted">{notice}</span>}</div>
            <div>
              <button type="button" className={action} disabled={busy} onClick={() => {
                if (discard()) clearEntry(true);
              }}>{record ? "下一台" : "清空表单"}</button>
              {!readOnly && <button type="button" className={primary} disabled={busy || !serial.trim()}
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

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Camera, Pencil, Plus, Search, Upload } from "lucide-react";
import { Dialog } from "./dialog";
import { FieldVisibility } from "./material-table";
import { CameraReader } from "./inspection";
import { RelatedRecordDialog, formatTime, type RelatedTarget } from "./record-details";
import { type Request, type Channel, type Order, type Device, type Shipment, type Page,
  path, contactFields, orderFields, items, costs, sources, isOrder, CarrierTags, SourceTag, Status, Tracking } from "./shipping-data";
import { CarrierPicker } from "./shipping-carrier";

type ImportReport = { added: number; updated: number; unchanged: number; duplicate: number; invalid: number;
  errors: { row: number; error: string }[] };

function DevicePicker({ request, devices, setDevices }: {
  request: Request; devices: Device[]; setDevices: (next: Device[]) => void;
}) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Device[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  function add(device: Device) {
    if (!devices.some((item) => item.serial === device.serial)) setDevices([...devices, { ...device, registered: true }]);
    setInput("");
    setResults([]);
    setMessage("");
  }
  async function search(value = input) {
    const term = value.trim();
    if (!term || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const found: Device[] = await request(path + "devices?" + new URLSearchParams({ q: term }));
      const exact = found.find((item) => item.serial.toLowerCase() === term.toLowerCase());
      if (exact) add(exact);
      else {
        setResults(found);
        if (!found.length) setMessage("当前项目没有匹配的设备");
      }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="shipping-device-picker">
    <h3>发货设备 <span className="muted">{devices.length} 台</span></h3>
    <div className="shipping-tools">
      <input aria-label="设备 S/N" placeholder="扫码或搜索设备 S/N" value={input} disabled={busy}
        onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void search();
          }
        }} />
      <button type="button" className="btn" disabled={!input.trim() || busy} onClick={() => void search()}><Search size={15} />查询</button>
      <button type="button" className="btn" disabled={busy} onClick={() => setCamera(true)}><Camera size={15} />扫码</button>
    </div>
    {message && <p className="muted" role="status">{message}</p>}
    {!!results.length && <div className="shipping-picker-list">
      {results.map((device) => <button type="button" key={device.serial} onClick={() => add(device)}>
        <span className="mono">{device.serial}</span><small>{[device.result, device.shipments && "已关联 " + device.shipments].filter(Boolean).join(" · ")}</small>
      </button>)}
    </div>}
    <div className="selected-records">
      {devices.map((device) => <span className="record-tag" key={device.serial}>
        <span className="mono">{device.serial}</span>
        {device.registered === false && <small>未匹配设备</small>}
        <button type="button" aria-label={"移除设备 " + device.serial} onClick={() =>
          setDevices(devices.filter((item) => item.serial !== device.serial))}>×</button>
      </span>)}
    </div>
    {camera && createPortal(<CameraReader live close={() => setCamera(false)} onRead={(value) => {
      setCamera(false);
      setInput(value);
      void search(value);
    }} />, document.body)}
  </section>;
}

function OrderImport({ request, close, done }: { request: Request; close: () => void; done: () => void }) {
  const [file, setFile] = useState<File>();
  const [report, setReport] = useState<ImportReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(commit: boolean) {
    if (!file || busy) return;
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await request(path + "orders/" + (commit ? "import" : "preview"), "POST", form);
      setReport(result);
      if (commit) done();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog title="导入 KS 发货信息" onClose={close}>
    <label className="form-label">KS 后台订单文件
      <input type="file" accept=".csv,.xlsx" disabled={busy} onChange={(event) => {
        setFile(event.target.files?.[0]);
        setReport(undefined);
        setError("");
      }} />
    </label>
    <p className="muted">支持 CSV 和 XLSX。按 Backer Number 合并，空白单元格保留原值。</p>
    {report && <div className="shipping-import-report" role="status">
      新增 {report.added} · 更新 {report.updated} · 无变化 {report.unchanged} · 重复 {report.duplicate} · 无效 {report.invalid}
      {!!report.errors.length && <ul>{report.errors.map(({ row, error }) => <li key={row}>第 {row} 行 · {error}</li>)}</ul>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="btn" type="button" disabled={!file || busy} onClick={() => void upload(false)}>预览</button>
      <button className="btn primary" type="button" disabled={!report || !!report.invalid || busy || !(report.added + report.updated)}
        onClick={() => void upload(true)}>确认导入</button>
    </div>
  </Dialog>;
}

function OrderPicker({ request, close, select }: { request: Request; close: () => void; select: (order: Order) => void }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <Dialog title="选择 KS 订单" onClose={close}>
    <form className="shipping-tools" onSubmit={async (event) => {
      event.preventDefault();
      if (!term.trim() || busy) return;
      setBusy(true);
      setMessage("");
      try {
        const result: Page = await request(path + "orders?" + new URLSearchParams({ q: term.trim(), lookup: "1" }));
        setRows(result.rows.filter(isOrder));
        if (!result.total) setMessage("没有找到匹配的 KS 订单");
      } catch (error) { setMessage((error as Error).message); }
      finally { setBusy(false); }
    }}>
      <input aria-label="搜索 KS 订单" placeholder="Backer 编号、邮箱或姓名" value={term} onChange={(e) => setTerm(e.target.value)} />
      <button className="btn" type="submit" disabled={busy || !term.trim()}><Search size={15} />查找订单</button>
    </form>
    {message && <p className="muted" role="status">{message}</p>}
    {!!rows.length && <div className="shipping-picker-list">
      {rows.map((row) => <button type="button" key={row.id} onClick={() => select(row)}>
        <strong>#{row.backer} {row.details.name}</strong>
        <small>{[row.details.email, row.details.country].filter(Boolean).join(" · ")}</small>
      </button>)}
    </div>}
  </Dialog>;
}

type Column = { key: string; label: string; width: number; fixed?: boolean; type?: "date" | "number" | "quantity" };
const fieldColumns = (fields: string[][], width: number, type?: Column["type"]): Column[] =>
  fields.map(([key, label]) => ({ key, label, width, type }));
const createdColumn: Column = { key: "created_at", label: "添加时间 ↓", width: 151 };
const orderColumns: Column[] = [
  { key: "backer", label: "Backer 编号", width: 130, fixed: true },
  createdColumn,
  ...fieldColumns(orderFields.filter(([key]) => !items.some(([item]) => item === key)), 145),
  ...fieldColumns(items, 88, "quantity"),
  { key: "status", label: "发货状态", width: 96 },
  { key: "shipments", label: "发货记录", width: 100 },
];
const orderWritable = (key: string) => key === "backer" || orderFields.some(([field]) => field === key);
const orderMovement: Record<string, [number, number]> = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
};
function shipmentColumns(channel: Channel): Column[] {
  return [
    { key: "reference", label: channel === "ks" ? "发货编号" : "订单号", width: 170, fixed: true },
    createdColumn,
    { key: channel === "ks" ? "backer" : "source", label: channel === "ks" ? "Backer 编号" : "来源", width: 120 },
    { key: "devices", label: "发货设备 S/N", width: 146 },
    { key: "shipped_on", label: "发货日期", width: 135, type: "date" },
    { key: "tracking", label: "运单号", width: 175 },
    { key: "status", label: "发货状态", width: 94 },
    { key: "carrier", label: "货代 / 承运商", width: 190 },
    ...fieldColumns(contactFields.filter(([key]) => ["name", "country"].includes(key)), 125),
    ...fieldColumns(items, 88, "quantity"),
    ...fieldColumns(costs, 100, "number"),
    ...fieldColumns(contactFields.filter(([key]) => !["name", "country"].includes(key)), 158),
    { key: "notes", label: "备注", width: 192 },
  ];
}

function emptyShipment(channel: Channel, order?: Order): Shipment {
  return {
    id: "", channel, reference: "", ks_order_id: order?.id || null, backer: order?.backer || null,
    shipped_on: "", tracking: "", details: Object.fromEntries(items.flatMap(([key]) =>
      order?.details[key] === undefined ? [] : [[key, order.details[key]]])),
    order_details: order?.details || {}, operator: null, created_at: "", updated_at: "", devices: [], source_id: null,
  };
}

type Update = (changes: Partial<Shipment>) => void;
function ShipmentCell({ row, column, edit, saving, open, pick, request }: {
  row: Shipment; column: Column; edit?: Update; open: (target: RelatedTarget) => void;
  saving: boolean;
  pick: (field: "order" | "devices") => void;
  request: Request;
}) {
  const key = column.key;
  if (key === "devices") {
    return <div className="shipping-relation-cell">
      {row.devices.slice(0, 1).map((device) => <button key={device.serial} type="button"
        className={"shipping-chip mono" + (device.registered === false ? " unresolved" : "")}
        title={device.serial} aria-label={"查看设备 " + device.serial}
        onClick={() => open({ kind: "device", serial: device.serial })}>{device.serial.slice(0, 6)}</button>)}
      {row.devices.length > 1 && <button type="button" className="shipping-chip"
        onClick={() => row.id ? open({ kind: "shipment", id: row.id, reference: row.reference }) : pick("devices")}
        aria-label={"查看全部 " + row.devices.length + " 台设备"}>+{row.devices.length - 1}</button>}
      {edit && <button type="button" className="shipping-relation-add" disabled={saving} onClick={() => pick("devices")}
        aria-label="选择发货设备"><Plus size={14} /></button>}
      {!row.devices.length && !edit && <span className="muted">—</span>}
    </div>;
  }
  if (key === "backer") return <div className="shipping-relation-cell">
    {row.ks_order_id && <button type="button" className="shipping-chip mono"
      onClick={() => open({ kind: "order", id: row.ks_order_id!, backer: row.backer || undefined })}>#{row.backer}</button>}
    {edit && <button type="button" className="shipping-relation-add" disabled={saving} aria-label="选择 KS 订单"
      onClick={() => pick("order")}><Plus size={14} /></button>}
    {!row.ks_order_id && !edit && <span className="muted">—</span>}
  </div>;
  if (key === "status") return <Status sent={!!(row.shipped_on || row.tracking)} />;
  if (key === "created_at") return <span>{row.created_at ? formatTime(row.created_at) : "—"}</span>;
  if (key === "carrier") return edit ? <CarrierPicker request={request} value={row.details.carrier} disabled={saving}
    onChange={(value) => edit({ details: { ...row.details, carrier: value } })} /> : <CarrierTags value={row.details.carrier} />;
  const field = key === "reference" || key === "shipped_on" || key === "tracking" ? key : undefined;
  const value = field ? row[field] : row.details[key] ?? row.order_details[key];
  const fromOrder = row.channel === "ks" && contactFields.some(([contact]) => key === contact);
  if (edit && !fromOrder) {
    const set = (input: string) => edit(field ? { [field]: input } : { details: { ...row.details, [key]: input } });
    if (key === "notes") return <textarea aria-label={column.label} rows={2} maxLength={3000} disabled={saving}
      value={row.details.notes ?? ""} onChange={(event) => set(event.target.value)} />;
    return <input aria-label={column.label} disabled={saving} type={column.type === "quantity" ? "number" : column.type || "text"}
      min={column.type === "number" || column.type === "quantity" ? 0 : undefined}
      step={column.type === "quantity" ? 1 : column.type === "number" ? "any" : undefined}
      list={key === "source" ? "shipping-sources" : undefined}
      value={field ? row[field] : row.details[key] ?? ""}
      placeholder={key === "reference" && row.channel === "ks" ? "自动编号" : undefined}
      onChange={(event) => set(event.target.value)} />;
  }
  if (key === "reference") return <button type="button" className="text-link mono shipping-reference"
    onClick={() => open({ kind: "shipment", id: row.id, reference: row.reference })}>{row.reference || "查看记录"}</button>;
  if (key === "tracking") return <Tracking shipment={row} />;
  if (key === "source") return <SourceTag value={row.details.source} />;
  const displayed = fromOrder ? value : field ? value : row.details[key];
  return <span title={String(displayed ?? "")}>{displayed === "" ? "—" : displayed ?? "—"}</span>;
}

export default function ShippingManagement({ request, admin, readOnly, onDraftChange }: {
  request: Request; admin: boolean; readOnly: boolean; onDraftChange: (dirty: boolean) => void;
}) {
  const [channel, setChannel] = useState<Channel>("ks");
  const [orders, setOrders] = useState(false);
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page>();
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<RelatedTarget>();
  const [edit, setEdit] = useState<Shipment>();
  const [picker, setPicker] = useState<"order" | "devices">();
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [hiddenFields, setHiddenFields] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem("plm-shipping-fields") || "{}") || {}; }
    catch { return {}; }
  });
  const [cursor, setCursor] = useState<{ id: string; key: string }>();
  const [orderEdit, setOrderEdit] = useState<{ row: Order; key: string; value: string }>();
  const orderSaving = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const view = orders ? "orders" : channel;
  const availableColumns = orders ? orderColumns : shipmentColumns(channel);
  const hidden = Array.isArray(hiddenFields[view]) ? hiddenFields[view] : [];
  const columns = availableColumns.filter((column) => column.fixed || !hidden.includes(column.key));
  const canPaste = orders && admin && !readOnly;
  const tableWidth = columns.reduce((total, column) => total + column.width, readOnly ? 45 : 149);
  const more = !!data && page * data.page_size < data.total;
  const rows = data?.rows || [];

  useEffect(() => {
    let active = true;
    setBusy(true);
    setLoadError("");
    const query = new URLSearchParams({ channel, q: search, status, page: String(page) });
    request(path + (orders ? "orders?" : "records?") + query).then(
      (result: Page) => {
        if (!active) return;
        setData((previous) => {
          if (page === 1 || !previous) return result;
          const loaded = new Map(previous.rows.map((row) => [row.id, row]));
          for (const row of result.rows) loaded.set(row.id, row);
          return { ...result, rows: [...loaded.values()] };
        });
      },
      (error) => { if (active) setLoadError(error.message); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [channel, orders, search, status, page, refresh, retry]);

  useEffect(() => {
    const node = tail.current;
    if (!node || busy || !more || loadError) return;
    let requested = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || requested) return;
      requested = true;
      setPage((value) => value + 1);
    }, { root: grid.current, rootMargin: "0px 0px 220px 0px" });
    observer.observe(node);
    return () => { requested = true; observer.disconnect(); };
  }, [busy, more, loadError, page]);

  useEffect(() => {
    onDraftChange(!!edit || !!orderEdit);
    if (!edit && !orderEdit) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      onDraftChange(false);
    };
  }, [!!edit, !!orderEdit]);

  function abandon() {
    if (saving || ((edit || orderEdit) && !window.confirm("放弃未保存的记录？"))) return false;
    setEdit(undefined);
    setOrderEdit(undefined);
    setSaveError("");
    return true;
  }
  function resetList() {
    grid.current?.scrollTo({ top: 0 });
    setData(undefined);
    setBusy(true);
    setPage(1);
    setCursor(undefined);
    setRefresh((value) => value + 1);
  }
  function select(next: Channel, showOrders = false) {
    if ((channel === next && orders === showOrders) || !abandon()) return;
    setChannel(next);
    setOrders(showOrders);
    setSearch("");
    setTerm("");
    setStatus("");
    setNotice("");
    resetList();
  }
  function begin(row: Shipment) {
    if (readOnly || (edit && !abandon())) return;
    setNotice("");
    setSaveError("");
    setEdit(row);
    if (!row.id) grid.current?.scrollTo({ top: 0, left: 0 });
  }
  function beginFromOrder(order: Order) {
    setOrders(false);
    setSearch("");
    setTerm("");
    setStatus("");
    resetList();
    begin(emptyShipment("ks", order));
  }
  const update: Update = (changes) => setEdit((row) => row && { ...row, ...changes });
  async function save() {
    if (!edit || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const saved: Shipment = await request(path + "records" + (edit.id ? "/" + edit.id : ""), edit.id ? "PUT" : "POST", {
        channel: edit.channel, reference: edit.reference, shipped_on: edit.shipped_on, tracking: edit.tracking,
        details: edit.details, ks_order_id: edit.ks_order_id, devices: edit.devices.map((device) => device.serial),
        version: edit.updated_at || undefined,
      });
      setEdit(undefined);
      if (edit.id) {
        const old = rows.find((row): row is Shipment => !isOrder(row) && row.id === saved.id);
        if (search ||
          (status && !!(old?.shipped_on || old?.tracking) !== !!(saved.shipped_on || saved.tracking))) resetList();
        else setData((previous) => previous && { ...previous, rows: previous.rows.map((row) => row.id === saved.id ? saved : row) });
      } else {
        setStatus("");
        setSearch("");
        setTerm("");
        resetList();
      }
      setNotice("发货记录已保存");
    } catch (error) { setSaveError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function pasteOrders(event: ClipboardEvent<HTMLDivElement>) {
    if (!canPaste || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const clipboard = event.clipboardData.getData("text/plain");
    if (!clipboard) return;
    event.preventDefault();
    if (saving || orderEdit) return;
    const fields = columns.filter((column) => orderWritable(column.key)).map((column) => column.key);
    const startColumn = cursor ? fields.indexOf(cursor.key) : 0;
    const startRow = cursor?.id ? rows.findIndex((row) => row.id === cursor.id) : -1;
    if (cursor?.id && startRow < 0) return;
    const targets = startRow < 0 ? [] : rows.slice(startRow, startRow + 1000).filter(isOrder).map((row) => ({
      id: row.id, version: row.updated_at, backer: row.backer,
    }));
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result: ImportReport = await request(path + "orders/paste", "POST", {
        clipboard, columns: startColumn < 0 ? [] : fields.slice(startColumn), targets,
      });
      if (result.added) {
        setTerm("");
        setSearch("");
        setStatus("");
      }
      if (result.added || result.updated) resetList();
      setNotice(`已粘贴 · 新增 ${result.added} 条 · 更新 ${result.updated} 条 · 跳过 ${result.unchanged + result.duplicate} 条`);
    } catch (error) { setSaveError((error as Error).message); }
    finally { setSaving(false); }
  }

  function selectCell(id: string, key: string) {
    if (!canPaste || !orderWritable(key) || saving) return;
    setCursor({ id, key });
    grid.current?.focus({ preventScroll: true });
  }
  function editOrderCell(row: Order, key: string) {
    if (!canPaste || saving || orderEdit || key === "backer" || !orderWritable(key)) return;
    setSaveError("");
    setCursor({ id: row.id, key });
    setOrderEdit({ row, key, value: String(row.details[key] ?? "") });
  }
  async function saveOrderCell() {
    if (!orderEdit || orderSaving.current) return;
    const { row, key, value } = orderEdit;
    if (value === String(row.details[key] ?? "")) { setOrderEdit(undefined); return; }
    orderSaving.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const saved: Order = await request(path + "orders/" + row.id, "PUT", {
        version: row.updated_at, details: { [key]: value },
      });
      setOrderEdit(undefined);
      setData((previous) => previous && { ...previous, rows: previous.rows.map((item) => item.id === saved.id ? saved : item) });
    } catch (error) { setSaveError((error as Error).message); }
    finally {
      setSaving(false);
      orderSaving.current = false;
    }
  }
  function orderKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!canPaste || event.target !== grid.current || saving) return;
    const fields = columns.filter((column) => orderWritable(column.key));
    const ids = ["", ...rows.map((row) => row.id)];
    if (event.key === "Enter" && cursor?.id) {
      const row = rows.find((item) => item.id === cursor.id);
      if (row && isOrder(row)) editOrderCell(row, cursor.key);
      return;
    }
    const move = orderMovement[event.key];
    if (!move) return;
    event.preventDefault();
    const row = Math.max(0, ids.indexOf(cursor?.id || ""));
    const col = Math.max(0, fields.findIndex((field) => field.key === cursor?.key));
    const id = ids[Math.max(0, Math.min(ids.length - 1, row + move[0]))];
    const key = fields[Math.max(0, Math.min(fields.length - 1, col + move[1]))].key;
    setCursor({ id, key });
    const cell = grid.current?.querySelector(`[data-order-row="${id}"][data-order-field="${key}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function orderCell(row: Order, column: Column) {
    const { key, label } = column;
    if (orderEdit?.row.id === row.id && orderEdit.key === key) {
      const props = {
        autoFocus: true, "aria-label": label, value: orderEdit.value, disabled: saving,
        onChange: (event: { target: { value: string } }) => setOrderEdit({ ...orderEdit, value: event.target.value }),
        onBlur: () => void saveOrderCell(),
        onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          if (event.key === "Escape" && !saving) {
            setOrderEdit(undefined);
            setSaveError("");
            requestAnimationFrame(() => grid.current?.focus({ preventScroll: true }));
          }
          if (event.key === "Enter" && !event.nativeEvent.isComposing && (key !== "notes" || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void saveOrderCell();
          }
        },
      };
      return key === "notes" ? <textarea {...props} rows={2} maxLength={3000} /> :
        <input {...props} type={column.type === "quantity" ? "number" : "text"} />;
    }
    const target: RelatedTarget = { kind: "order", id: row.id, backer: row.backer };
    if (key === "backer") return <button type="button" className="text-link mono" onClick={() => setDetail(target)}>#{row.backer}</button>;
    if (key === "created_at") return <span>{formatTime(row.created_at)}</span>;
    if (key === "status") return <Status sent={row.shipped > 0} />;
    if (key === "shipments") return row.shipments > 0 ? <button type="button" className="shipping-chip"
      onClick={() => setDetail(target)}>{row.shipments} 条</button> : "—";
    return <span title={String(row.details[key] ?? "")}>{row.details[key] ?? "—"}</span>;
  }

  const shipmentRow = (item: Shipment, index: number | string) => {
    const editing = edit && edit.id === item.id;
    const row = editing ? edit : item;
    return <tr key={row.id || "new"} className={editing ? "shipping-row-editing" : ""} aria-busy={editing && saving}>
      <td className="shipping-row-index">{!readOnly && !editing && <button type="button" className="shipping-mobile-edit"
        aria-label={"编辑第 " + index + " 行"} title="编辑" disabled={saving} onClick={() => begin(row)}><Pencil size={12} /></button>}
        {index}</td>
      {columns.map((column) => <td key={column.key} onDoubleClick={(event) => {
        if (!editing && !["reference", "backer", "devices", "status", "tracking", "created_at"].includes(column.key) &&
          !(channel === "ks" && contactFields.some(([key]) => key === column.key))) {
          const cell = event.currentTarget;
          begin(row);
          requestAnimationFrame(() => cell.querySelector<HTMLElement>("input,textarea,button")?.focus());
        }
      }}>
        <ShipmentCell row={row} column={column} edit={editing ? update : undefined} saving={saving}
          open={setDetail} pick={setPicker} request={request} />
      </td>)}
      {!readOnly && <td className="shipping-row-action">{editing ? <>
        <button type="button" className="btn small primary" onClick={() => void save()} disabled={saving}>保存</button>
        <button type="button" className="btn small" disabled={saving} onClick={() => { setEdit(undefined); setSaveError(""); }}>取消</button>
      </> : <button type="button" className="btn small" disabled={saving} onClick={() => begin(row)}>编辑</button>}</td>}
    </tr>;
  };
  return <section className="shipping-management">
    <div className="page-heading"><h1>发货管理</h1></div>
    <div className="tabs page-tabs" aria-label="发货渠道">
      <button type="button" className={channel === "other" ? "selected" : ""} onClick={() => select("other")}>其他发货管理</button>
      <button type="button" className={channel === "ks" ? "selected" : ""} onClick={() => select("ks")}>KS 发货管理</button>
    </div>
    <div className="shipping-toolbar">
      <form className="shipping-tools" onSubmit={(event) => {
        event.preventDefault();
        if (abandon()) { setSearch(term.trim()); resetList(); }
      }}>
        <input aria-label="搜索发货" placeholder={orders ? "Backer 编号、收件人或邮箱" : "订单号、运单号或设备 S/N"}
          value={term} onChange={(event) => setTerm(event.target.value)} />
        <select aria-label="发货状态" value={status} onChange={(event) => {
          if (abandon()) { setStatus(event.target.value); resetList(); }
        }}>
          <option value="">全部状态</option><option value="shipped">已发货</option><option value="pending">待发货</option>
        </select>
        <button type="submit" className="btn"><Search size={15} />搜索</button>
      </form>
      <div className="shipping-tools">
        <FieldVisibility columns={availableColumns} hidden={hidden} onChange={(next) => {
          if (orderEdit && next.includes(orderEdit.key) && !abandon()) return;
          const updated = { ...hiddenFields, [view]: next };
          setHiddenFields(updated);
          if (cursor && next.includes(cursor.key)) setCursor(undefined);
          try { localStorage.setItem("plm-shipping-fields", JSON.stringify(updated)); }
          catch { /* The current view still reflects the selection. */ }
        }} />
        {channel === "ks" && <button className="btn" type="button" onClick={() => select("ks", !orders)}>
          {orders ? "返回 KS 发货台账" : "KS 发货信息"}
        </button>}
        {!readOnly && (orders ? admin && <button className="btn primary" type="button" onClick={() => setImporting(true)}>
          <Upload size={15} />导入 KS 订单
        </button> : edit ? <>
          <button type="button" className="btn" disabled={saving} onClick={() => { setEdit(undefined); setSaveError(""); }}>取消编辑</button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存当前行"}
          </button>
        </> : <button className="btn primary" type="button" onClick={() => begin(emptyShipment(channel))}><Plus size={16} />登记发货</button>)}
      </div>
    </div>
    <datalist id="shipping-sources">{sources.map((source) => <option key={source} value={source} />)}</datalist>
    {notice && <p className="shipping-notice" role="status">{notice}</p>}
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    {canPaste && <p className="shipping-paste-hint muted">复制飞书或 Excel 单元格，选中起始位置后粘贴。新增可粘贴带表头的数据。</p>}
    <div className="table-wrap shipping-table" ref={grid} aria-busy={busy || saving}
      aria-label={orders ? "KS 发货信息" : "发货台账"} tabIndex={0} onPaste={(event) => void pasteOrders(event)}
      onKeyDown={orderKeys}>
      <table style={{ width: tableWidth }}>
        <colgroup><col style={{ width: 45 }} />{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
          {!readOnly && <col style={{ width: 104 }} />}</colgroup>
        <thead><tr><th className="shipping-row-index" scope="col">#</th>
          {columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}
          {!readOnly && <th className="shipping-row-action" scope="col">操作</th>}
        </tr></thead>
        <tbody>
          {!orders && edit?.id === "" && shipmentRow(edit, "＋")}
          {canPaste && <tr className="shipping-paste-row">
            <td className="shipping-row-index">＋</td>
            {columns.map(({ key }) => <td key={key} data-order-row="" data-order-field={key}
              className={cursor?.id === "" && cursor.key === key ? "shipping-cell-selected" : ""}
              onClick={() => selectCell("", key)}>
              {key === "backer" && <button type="button" className="text-link"
                onClick={() => selectCell("", "backer")}>粘贴新记录</button>}
            </td>)}
            <td className="shipping-row-action"></td>
          </tr>}
          {rows.map((row, index) => {
            if (!isOrder(row)) return shipmentRow(row, index + 1);
            return <tr key={row.id}><td className="shipping-row-index">{index + 1}</td>
              {columns.map((column) => <td key={column.key} data-order-row={row.id} data-order-field={column.key}
                className={cursor?.id === row.id && cursor.key === column.key ? "shipping-cell-selected" : ""}
                onClick={(event) => {
                  if (!orderEdit && event.target instanceof Element && !event.target.closest("button")) selectCell(row.id, column.key);
                }}
                onDoubleClick={() => editOrderCell(row, column.key)}>{orderCell(row, column)}</td>)}
              {!readOnly && <td className="shipping-row-action"><button className="btn small" type="button"
                onClick={() => beginFromOrder(row)}>登记发货</button></td>}
            </tr>;
          })}
        </tbody>
      </table>
      {!busy && !loadError && !rows.length && !edit && <p className="shipping-empty">暂无{orders ? "KS 订单" : "发货记录"}</p>}
      {loadError && <div className="shipping-load-error" role="alert">{loadError}
        <button type="button" className="btn small" onClick={() => setRetry((value) => value + 1)}>重试</button>
      </div>}
      <div ref={tail} className="shipping-load-tail" style={{ width: tableWidth }}>{busy ? "正在加载…" : ""}</div>
    </div>
    <div className="shipping-count" role="status">已加载 {rows.length} / {data?.total ?? rows.length} 条</div>
    {detail && <RelatedRecordDialog target={detail} request={request} close={() => setDetail(undefined)} />}
    {picker === "order" && edit && <OrderPicker request={request} close={() => setPicker(undefined)} select={(order) => {
      const details = { ...edit.details };
      if (!edit.id) for (const [key] of items) {
        if (details[key] === undefined && order.details[key] !== undefined) details[key] = order.details[key];
      }
      update({ ks_order_id: order.id, backer: order.backer, order_details: order.details, details });
      setPicker(undefined);
    }} />}
    {picker === "devices" && edit && <Dialog title="选择发货设备" onClose={() => setPicker(undefined)} wide>
      <DevicePicker request={request} devices={edit.devices} setDevices={(devices) => update({ devices })} />
      <div className="dialog-actions"><button className="btn primary" type="button" onClick={() => setPicker(undefined)}>完成</button></div>
    </Dialog>}
    {importing && <OrderImport request={request} close={() => setImporting(false)} done={() => {
      setImporting(false); resetList(); setNotice("KS 订单已导入");
    }} />}
  </section>;
}

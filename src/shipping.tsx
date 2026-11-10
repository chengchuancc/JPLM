import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Camera, Plus, Search, Upload } from "lucide-react";
import { Dialog } from "./dialog";
import { CameraReader } from "./inspection";
import "./shipping.css";

type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
type Channel = "ks" | "other";
type Details = Record<string, string | number>;
type Order = { id: string; backer: string; details: Details; shipped: number; shipments: number };
type Device = { serial: string; registered?: boolean; result?: string; shipments?: string };
type Shipment = {
  id: string; channel: Channel; reference: string; ks_order_id: string | null; backer: string | null;
  shipped_on: string; tracking: string; details: Details; order_details: Details; operator: string | null;
  updated_at: string; devices: Device[]; source_id: string | null;
};
type Page = { rows: (Order | Shipment)[]; total: number; page: number; page_size: number };
type ImportReport = { added: number; updated: number; unchanged: number; duplicate: number; invalid: number;
  errors: { row: number; error: string }[] };

const path = "shipping/";
const contactFields = [
  ["name", "收件人"], ["phone", "电话"], ["email", "邮箱"], ["country", "国家 / 地区"],
  ["region", "州 / 省"], ["city", "城市"], ["postcode", "邮编"],
  ["address", "地址"], ["address2", "地址补充"],
];
const items = [["main_unit", "主机"], ["base", "底座"], ["case", "收纳包"], ["strip", "条形反光贴"], ["patch", "块状反光贴"]];
const costs = [["domestic_cost", "国内运费"], ["international_cost", "海外运费"], ["warehouse_cost", "海外仓运费"], ["weight", "包裹重量（g）"]];
const orderFields = [...contactFields, ["country_code", "国家代码"], ["pb", "PB 编号"], ["sku", "SKU"],
  ["address_status", "地址确认"], ["pledged", "KS 承诺金额"], ["amount_due", "KS 应付金额"], ["paid", "已支付金额"],
  ["balance", "欠款"], ["notes", "备注"], ...items];
const shipmentFields = [["source", "来源"], ["carrier", "货代 / 承运商"], ...costs, ...items, ["notes", "备注"]];
const sources = ["Shopify", "Amazon", "Indiegogo", "AliExpress", "经销商", "KOL", "其他"];
const dateText = (value: string) => value || "—";
const isOrder = (row: Order | Shipment): row is Order => "shipments" in row;

function Status({ sent }: { sent: boolean }) {
  return <span className={"shipping-status" + (sent ? " sent" : "")}>{sent ? "已发货" : "待发货"}</span>;
}

function DetailsList({ fields, details }: { fields: string[][]; details: Details }) {
  return <dl className="shipping-details">{fields.filter(([key]) => details[key] !== undefined && details[key] !== "")
    .map(([key, label]) => <div key={key} className={key.startsWith("address") || key === "notes" ? "wide-field" : ""}>
      <dt>{label}</dt><dd>{details[key]}</dd>
    </div>)}</dl>;
}

function Tracking({ shipment }: { shipment: Shipment }) {
  if (!shipment.tracking) return <>—</>;
  const address = "https://t.17track.net/en#nums=" + encodeURIComponent(shipment.tracking);
  return <a className="text-link mono" href={address} target="_blank" rel="noreferrer">{shipment.tracking}</a>;
}

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

function ShipmentForm({ channel, shipment, initialOrder, request, close, saved }: {
  channel: Channel; shipment?: Shipment; initialOrder?: Order; request: Request;
  close: () => void; saved: () => void;
}) {
  const [order, setOrder] = useState<Order | undefined>(initialOrder || (shipment?.ks_order_id && shipment.backer
    ? { id: shipment.ks_order_id, backer: shipment.backer, details: shipment.order_details, shipments: 0, shipped: 0 } : undefined));
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Order[]>([]);
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState(shipment?.reference || "");
  const [date, setDate] = useState(shipment?.shipped_on || "");
  const [tracking, setTracking] = useState(shipment?.tracking || "");
  const [details, setDetails] = useState<Details>(() => shipment?.details ||
    Object.fromEntries(items.flatMap(([key]) => initialOrder?.details[key] === undefined ? [] : [[key, initialOrder.details[key]]])));
  const [devices, setDevices] = useState(shipment?.devices || []);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  async function searchOrders() {
    if (!query.trim() || searching) return;
    setSearching(true);
    setMessage("");
    try {
      const page = await request(path + "orders?" + new URLSearchParams({ q: query.trim() }));
      setFound(page.rows);
      if (!page.total) setMessage("没有找到匹配的 KS 订单");
    } catch (e) { setMessage((e as Error).message); }
    finally { setSearching(false); }
  }
  function setOrderValues(next: Order) {
    setOrder(next);
    setFound([]);
    setQuery("");
    setDetails((previous) => {
      const updated = { ...previous };
      for (const [key] of items) if (updated[key] === undefined && next.details[key] !== undefined) updated[key] = next.details[key];
      return updated;
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await request(path + "records" + (shipment ? "/" + shipment.id : ""), shipment ? "PUT" : "POST", {
        channel, reference, shipped_on: date, tracking, details,
        ks_order_id: order?.id, devices: devices.map((item) => item.serial), version: shipment?.updated_at,
      });
      saved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const update = (key: string, value: string) => setDetails((previous) => ({ ...previous, [key]: value }));
  return <Dialog title={shipment ? "编辑发货记录" : channel === "ks" ? "登记 KS 发货" : "登记其他发货"} onClose={close} wide>
    <form onSubmit={submit}>
      {channel === "ks" && <section className="shipping-order-picker">
        <h3>KS 订单</h3>
        <div className="shipping-tools">
          <input aria-label="搜索 KS 订单" placeholder="Backer 编号、邮箱或姓名" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void searchOrders(); }
            }} />
          <button className="btn" type="button" disabled={!query.trim() || searching} onClick={() => void searchOrders()}>
            <Search size={15} />查找订单
          </button>
        </div>
        {message && <p className="muted" role="status">{message}</p>}
        {!!found.length && <div className="shipping-picker-list">
          {found.map((item) => <button type="button" key={item.id} onClick={() => setOrderValues(item)}>
            <strong>#{item.backer} {item.details.name}</strong><small>{[item.details.email, item.details.country].filter(Boolean).join(" · ")}</small>
          </button>)}
        </div>}
        {order && <div className="shipping-order-summary">
          <strong>Backer #{order.backer}</strong>
          <DetailsList fields={[...contactFields, ["address_status", "地址确认"]]} details={order.details} />
        </div>}
      </section>}
      <div className="form-grid shipping-form-fields">
        <label>{channel === "ks" ? "发货编号" : "订单号"}<input value={reference}
          required={channel === "other" && !shipment?.source_id} placeholder={channel === "ks" ? "留空自动编号" : ""} maxLength={150}
          onChange={(event) => setReference(event.target.value)} /></label>
        {channel === "other" && <label>来源<input list="shipping-sources" value={details.source ?? ""}
          onChange={(event) => update("source", event.target.value)} /><datalist id="shipping-sources">
            {sources.map((source) => <option key={source} value={source} />)}
          </datalist></label>}
        <label>发货日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>运单号<input value={tracking} maxLength={500} onChange={(event) => setTracking(event.target.value)} /></label>
        <label>货代 / 承运商<input value={details.carrier ?? ""} onChange={(event) => update("carrier", event.target.value)} /></label>
        {channel === "other" && contactFields.map(([key, label]) => <label key={key}
          className={key.startsWith("address") ? "wide-field" : ""}>{label}
          <input value={details[key] ?? ""} onChange={(event) => update(key, event.target.value)} />
        </label>)}
      </div>
      <DevicePicker request={request} devices={devices} setDevices={setDevices} />
      <div className="form-grid shipping-form-fields">
        {items.map(([key, label]) => <label key={key}>{label}<input type="number" min={0} step={1}
          value={details[key] ?? ""} onChange={(event) => update(key, event.target.value)} /></label>)}
        {costs.map(([key, label]) => <label key={key}>{label}<input type="number" min={0} step="any"
          value={details[key] ?? ""} onChange={(event) => update(key, event.target.value)} /></label>)}
        <label className="wide-field">备注<textarea rows={2} maxLength={3000} value={details.notes ?? ""}
          onChange={(event) => update("notes", event.target.value)} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" type="button" onClick={close} disabled={busy}>取消</button>
        <button className="btn primary" type="submit" disabled={busy || (channel === "ks" && !order && !shipment)}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  </Dialog>;
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

export function ShippingManagement({ request, admin, readOnly }: {
  request: Request; admin: boolean; readOnly: boolean;
}) {
  const [channel, setChannel] = useState<Channel>("ks");
  const [orders, setOrders] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [backer, setBacker] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<Order | Shipment>();
  const [edit, setEdit] = useState<{ shipment?: Shipment; order?: Order }>();
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ channel, q: search, backer, status, page: String(page) });
    request(path + (orders ? "orders?" : "records?") + query).then(
      (result) => { if (active) setData(result); },
      (e) => { if (active) { setError(e.message); setData(undefined); } },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [channel, orders, search, backer, status, page, revision]);
  function select(next: Channel, showOrders = false) {
    if (channel === next && orders === showOrders) return;
    setChannel(next);
    setOrders(showOrders);
    setPage(1);
    setStatus("");
    setSearch("");
    setDraft("");
    setBacker("");
    setData(undefined);
    setNotice("");
  }
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.page_size || 50)));
  function shipmentSaved() {
    select(channel);
    setEdit(undefined);
    setPage(1);
    setRevision((value) => value + 1);
    setNotice("发货记录已保存");
  }
  return <section className="shipping-management">
    <div className="page-heading"><h1>发货管理</h1></div>
    <div className="tabs page-tabs" aria-label="发货渠道">
      <button type="button" className={channel === "ks" ? "selected" : ""} onClick={() => select("ks")}>KS 发货管理</button>
      <button type="button" className={channel === "other" ? "selected" : ""} onClick={() => select("other")}>其他发货管理</button>
    </div>
    <div className="shipping-toolbar">
      <form className="shipping-tools" onSubmit={(event) => {
        event.preventDefault();
        setBacker("");
        setSearch(draft.trim());
        setPage(1);
      }}>
        <input aria-label="搜索发货" placeholder={orders ? "Backer 编号、收件人或邮箱" : "订单号、运单号或设备 S/N"}
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        <select aria-label="发货状态" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">全部状态</option><option value="shipped">已发货</option><option value="pending">待发货</option>
        </select>
        <button type="submit" className="btn"><Search size={15} />搜索</button>
      </form>
      <div className="shipping-tools">
        {channel === "ks" && <button className="btn" type="button" onClick={() => select("ks", !orders)}>
          {orders ? "返回 KS 发货台账" : "KS 发货信息"}
        </button>}
        {!readOnly && (orders ? admin && <button className="btn primary" type="button" onClick={() => setImporting(true)}>
          <Upload size={15} />导入 KS 订单
        </button> : <button className="btn primary" type="button" onClick={() => setEdit({})}><Plus size={16} />登记发货</button>)}
      </div>
    </div>
    {notice && <p className="shipping-notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="table-wrap shipping-table" aria-busy={busy}>
      <table>
        <thead><tr>{(orders
          ? ["Backer 编号", "收件人", "国家 / 地区", "地址确认", "发货状态", "发货记录", "操作"]
          : [channel === "ks" ? "发货编号" : "订单号", channel === "ks" ? "Backer 编号" : "来源",
            "收件人", "设备 S/N", "发货日期", "运单号", "状态", "操作"]).map((label) => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{data?.rows.map((row) => isOrder(row)
          ? <tr key={row.id}>
            <td><button type="button" className="text-link mono" onClick={() => setDetail(row)}>#{row.backer}</button></td>
            <td>{row.details.name || "—"}</td><td>{row.details.country || "—"}</td><td>{row.details.address_status || "—"}</td>
            <td><Status sent={row.shipped > 0} /></td><td>{row.shipments}</td>
            <td>{!readOnly && <button className="btn small" type="button" onClick={() => setEdit({ order: row })}>登记发货</button>}</td>
          </tr> : <tr key={row.id}>
            <td><button type="button" className="text-link mono" onClick={() => setDetail(row)}>{row.reference || "查看记录"}</button></td>
            <td>{row.channel === "ks" ? row.backer ? "#" + row.backer : "—" : row.details.source || "—"}</td>
            <td>{row.details.name || row.order_details.name || "—"}</td>
            <td className="shipping-serial-cell">{row.devices.length ? <>
              <span className="mono">{row.devices[0].serial}</span>
              {row.devices.length > 1 && <button className="text-link" type="button" onClick={() => setDetail(row)}>＋{row.devices.length - 1}</button>}
            </> : "—"}</td>
            <td>{dateText(row.shipped_on)}</td><td><Tracking shipment={row} /></td>
            <td><Status sent={!!(row.shipped_on || row.tracking)} /></td>
            <td>{!readOnly && <button className="btn small" type="button" onClick={() => setEdit({ shipment: row })}>编辑</button>}</td>
          </tr>)}</tbody>
      </table>
      {!busy && !error && !data?.rows.length && <p className="shipping-empty">暂无{orders ? "KS 订单" : "发货记录"}</p>}
    </div>
    <div className="shipping-pagination">
      <span>{busy ? "加载中…" : "共 " + (data?.total || 0) + " 条"}</span>
      <button type="button" className="btn small" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{page} / {pages}</span>
      <button type="button" className="btn small" disabled={busy || page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>
    {detail && <Dialog title={isOrder(detail) ? "Backer #" + detail.backer : detail.reference || "发货记录"} wide onClose={() => setDetail(undefined)}>
      {isOrder(detail) ? <>
        <div className="shipping-tools"><Status sent={detail.shipped > 0} /><span>发货记录 {detail.shipments} 条</span></div>
        <DetailsList fields={orderFields} details={detail.details} />
        {!!detail.shipments && <button className="btn" type="button" onClick={() => {
          select("ks"); setBacker(detail.backer); setDraft("#" + detail.backer); setDetail(undefined);
        }}>查看发货记录</button>}
      </> : <>
        <div className="shipping-tools">
          <Status sent={!!(detail.shipped_on || detail.tracking)} />
          {detail.backer && <strong>Backer #{detail.backer}</strong>}
          <span>发货日期 {dateText(detail.shipped_on)}</span><span>运单号 <Tracking shipment={detail} /></span>
          {detail.operator && <span>经办人 {detail.operator}</span>}
        </div>
        <DetailsList fields={contactFields} details={{ ...detail.order_details, ...detail.details }} />
        <DetailsList fields={shipmentFields} details={detail.details} />
        <h3>发货设备</h3>
        <ul className="shipping-device-detail">
          {detail.devices.map((device) => <li key={device.serial}><span className="mono">{device.serial}</span>
            <small>{device.registered ? device.result || "待检测" : "未匹配设备"}</small></li>)}
          {!detail.devices.length && <li>暂无关联设备</li>}
        </ul>
      </>}
    </Dialog>}
    {edit && <ShipmentForm channel={channel} shipment={edit.shipment} initialOrder={edit.order} request={request}
      close={() => setEdit(undefined)} saved={shipmentSaved} />}
    {importing && <OrderImport request={request} close={() => setImporting(false)} done={() => {
      setImporting(false); setPage(1); setRevision((value) => value + 1); setNotice("KS 订单已导入");
    }} />}
  </section>;
}

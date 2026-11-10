import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { Dialog } from "./dialog";
import type { RecordRow } from "./inspection";
import { contactFields, otherContactFields, costs, items, orderFields, CarrierTags, SourceTag, Status, Tracking, DetailsList, isShipped, shipmentLabel,
  type Request, type Order, type Shipment } from "./shipping-data";
import "./shipping.css";
import { ShipmentItems } from "./shipping-items";

export function formatTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}
export function ResultLabel({ value }: { value: string }) {
  const tone = value === "不良" || value === "NG" ? "fail" : value === "合格" || value === "OK" ? "pass" :
    value === "未完成" ? "incomplete" : "pending";
  return <span className={"inspection-result " + tone}>{value}</span>;
}

export function sections<T extends { group: string }>(fields: T[]) {
  const groups = new Map<string, T[]>();
  for (const field of fields) {
    const group = field.group || "检测项";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(field);
  }
  return [...groups];
}

export type RelatedTarget =
  | { kind: "inspection"; record: RecordRow }
  | { kind: "device"; serial: string }
  | { kind: "shipment"; id: string; reference?: string }
  | { kind: "order"; id: string; backer?: string };

type Open = (target: RelatedTarget) => void;
type ShipmentLink = Pick<Shipment, "id" | "reference" | "channel" | "shipped_on" | "tracking" | "backer">;

function useDetail<T>(request: Request, path: string) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    request(path).then((result) => { if (current) setValue(result); },
      (e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [path]);
  return { value, error };
}

function Loading({ error }: { error: string }) {
  return error ? <p className="form-error" role="alert">{error}</p> : <p className="muted">正在加载…</p>;
}

function ShipmentLinks({ rows, open }: { rows: ShipmentLink[]; open: Open }) {
  return <ul className="shipping-device-detail">{rows.map((item) => (
    <li key={item.id}>
      <button type="button" className="text-link mono"
        onClick={() => open({ kind: "shipment", id: item.id, reference: shipmentLabel(item) })}>
        {shipmentLabel(item)}
      </button>
      <small>{[item.channel === "ks" ? "KS" : "其他", item.backer && "Backer #" + item.backer,
        item.shipped_on, item.tracking].filter(Boolean).join(" · ")}</small>
    </li>
  ))}</ul>;
}

function LinkedShipments({ serial, request, open }: { serial: string; request: Request; open: Open }) {
  const { value, error } = useDetail<ShipmentLink[]>(request,
    "shipping/device-records?" + new URLSearchParams({ serial }));
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!value?.length) return null;
  return <section className="inspection-detail-group">
    <h3>关联发货</h3><ShipmentLinks rows={value} open={open} />
  </section>;
}

function InspectionDetails({ record, request, open }: { record: RecordRow; request: Request; open: Open }) {
  return <>
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
    <LinkedShipments serial={record.serial} request={request} open={open} />
    {sections(record.form.fields).map(([group, fields]) => (
      <section className="inspection-detail-group" key={group}>
        <h3>{group}</h3>
        <dl className="inspection-detail-grid">
          {fields.map((field) => {
            const value = record.values[field.key];
            const text = Array.isArray(value) ? value.join("、") : value;
            return <div key={field.key} className={field.type === "multi" || field.type === "text" ? "wide-field" : ""}>
              <dt>{field.label}</dt>
              <dd>{field.type === "choice" && (text === "OK" || text === "NG") ? <ResultLabel value={text} /> :
                text === undefined || text === "" ? "—" : <>{text}{field.unit && " " + field.unit}</>}</dd>
            </div>;
          })}
        </dl>
      </section>
    ))}
  </>;
}

function DeviceDetails({ serial, request, open }: { serial: string; request: Request; open: Open }) {
  const { value, error } = useDetail<{ device: { production_date: string; registered_at: string } | null; records: RecordRow[] }>(
    request, "inspection/device-inspections?" + new URLSearchParams({ serial }));
  if (!value) return <Loading error={error} />;
  return <>
    <div className="inspection-record-summary"><strong className="mono">{serial}</strong>
      {value.device && <span>已登记</span>}
    </div>
    {value.device && <DetailsList fields={[["production_date", "生产日期"], ["registered_at", "登记时间"]]}
      details={{ ...value.device, registered_at: formatTime(value.device.registered_at) }} />}
    {!value.records.length && <p className="shipping-detail-empty muted">{value.device ? "该设备暂无检测记录" : "该编号未匹配设备台账"}</p>}
    {value.records.length === 1 && <InspectionDetails record={value.records[0]} request={request} open={open} />}
    {value.records.length > 1 && <section className="inspection-detail-group">
      <h3>检测记录 <span className="muted">{value.records.length} 条</span></h3>
      <ul className="shipping-device-detail">{value.records.map((row) => (
        <li key={row.id}><button type="button" className="text-link"
          onClick={() => open({ kind: "inspection", record: row })}>{row.form.name}</button>
          <span>{formatTime(row.updated_at)} <ResultLabel value={row.result} /></span></li>
      ))}</ul>
    </section>}
    {value.records.length !== 1 && <LinkedShipments serial={serial} request={request} open={open} />}
  </>;
}

function ChildShipmentLinks({ id, request, open }: { id: string; request: Request; open: Open }) {
  const { value, error } = useDetail<ShipmentLink[]>(request, "shipping/records/" + id + "/children");
  return value ? <ShipmentLinks rows={value} open={open} /> : <Loading error={error} />;
}

function ShipmentDetails({ id, request, open, navigation }: {
  id: string; request: Request; open: Open; navigation?: (row: Shipment) => ReactNode;
}) {
  const { value: row, error } = useDetail<Shipment>(request, "shipping/records/" + id);
  if (!row) return <Loading error={error} />;
  const title = row.channel === "ks" ? "发货编号" : "订单号";
  const parentLabel = row.parent_reference || row.parent_tracking || "发货记录";
  return <>
    <div className="inspection-record-summary">
      <div><span>{title}</span> <strong className="mono">{row.reference || "—"}</strong></div>
      {row.deleted_at ? <span className="muted">已删除 · {formatTime(row.deleted_at)}</span>
        : <Status sent={isShipped(row)} />}
    </div>
    {navigation && <div className="shipping-detail-navigation">{navigation(row)}</div>}
    <div className="shipping-record-fields">
    <section className="shipping-detail-section">
      <h3>发货与物流</h3>
      <dl className="shipping-details">
        <div><dt>来源</dt><dd><SourceTag value={row.channel === "ks" ? "Kickstarter" : row.details.source} /></dd></div>
        <div><dt>添加时间</dt><dd>{formatTime(row.created_at)}</dd></div>
        {row.ks_order_id && <div><dt>KS 订单</dt><dd><button type="button" className="text-link"
          onClick={() => open({ kind: "order", id: row.ks_order_id!, backer: row.backer || undefined })}>
          Backer #{row.backer}</button></dd></div>}
        <div><dt>发货日期</dt><dd>{row.shipped_on || "—"}</dd></div>
        <div><dt>运单号</dt><dd><Tracking shipment={row} /></dd></div>
        <div><dt>货代 / 承运商</dt><dd><CarrierTags value={row.details.carrier} /></dd></div>
        <div><dt>经办人</dt><dd>{row.operator || "—"}</dd></div>
      </dl>
      <DetailsList fields={costs} details={row.details} showEmpty />
    </section>
    {(row.parent_id || row.child_count > 0) && <section className="shipping-detail-section">
      <h3>父子记录</h3>
      {row.parent_id && <dl className="shipping-details"><div><dt>父记录</dt><dd>
        <button type="button" className="text-link mono" onClick={() =>
          open({ kind: "shipment", id: row.parent_id!, reference: parentLabel })}>{parentLabel}</button>
      </dd></div></dl>}
      {row.child_count > 0 && <><h4>子记录 · {row.child_count} 条</h4>
        <ChildShipmentLinks id={id} request={request} open={open} /></>}
    </section>}
    {!row.shared && <section className="shipping-detail-section"><h3>收件资料</h3>
      <DetailsList fields={row.channel === "ks" ? [...contactFields, ["address_status", "地址确认"]] : otherContactFields}
        details={row.channel === "ks" ? row.order_details : row.details} showEmpty />
    </section>}
    {row.channel === "other" &&
      <section className="shipping-detail-section"><h3>发货商品</h3>
        <ShipmentItems items={row.shipment_items} showProject links />
      </section>}
    {row.ks_order_id && <section className="shipping-detail-section"><h3>KS 订单数量</h3>
      <DetailsList fields={[["sku", "SKU"], ...items]} details={row.order_details} showEmpty />
    </section>}
    {!row.shared && <section className="shipping-detail-section"><h3>发货设备 <span className="muted">{row.devices.length} 台</span></h3>
      <ul className="shipping-device-detail">
        {row.devices.map((device) => <li key={device.serial}>
          <button className="text-link mono" type="button" onClick={() => open({ kind: "device", serial: device.serial })}>{device.serial}</button>
          <small>{device.registered ? device.result || "待检测" : "未匹配设备"}</small></li>)}
        {!row.devices.length && <li>暂无关联设备</li>}
      </ul>
    </section>}
    <section className="shipping-detail-section"><h3>备注与时间</h3>
      <DetailsList fields={[["notes", "备注"], ["updated_at", "更新时间"], ["source_id", "来源记录 ID"]]}
        details={{ ...row.details, updated_at: formatTime(row.updated_at), source_id: row.source_id || "" }} showEmpty />
    </section>
    </div>
  </>;
}

function OrderDetails({ id, request, open }: { id: string; request: Request; open: Open }) {
  const { value: row, error } = useDetail<Order & { shipment_links: ShipmentLink[] }>(request, "shipping/orders/" + id);
  if (!row) return <Loading error={error} />;
  return <>
    <div className="shipping-tools"><Status sent={row.shipped > 0} /><span>发货记录 {row.shipments} 条</span></div>
    <div className="shipping-record-fields">
      <section className="shipping-detail-section"><h3>订单资料</h3>
        <DetailsList fields={[["created_at", "添加时间"], ...orderFields]} showEmpty
          details={{ ...row.details, created_at: formatTime(row.created_at) }} />
      </section>
    </div>
    {!!row.shipment_links.length && <section className="shipping-detail-section"><h3>关联发货</h3>
      <ShipmentLinks rows={row.shipment_links} open={open} />
    </section>}
  </>;
}

export function RelatedRecordDialog({ target, request, close, shipmentNavigation }: {
  target: RelatedTarget; request: Request; close: () => void; shipmentNavigation?: (row: Shipment) => ReactNode;
}) {
  const [trail, setTrail] = useState<RelatedTarget[]>([target]);
  const current = trail[trail.length - 1];
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = content.current?.closest(".dialog");
    dialog?.scrollTo({ top: 0 });
    dialog?.querySelector<HTMLButtonElement>(trail.length > 1 ? ".shipping-detail-back" : ".dialog-heading button")?.focus();
  }, [current]);
  const open: Open = (next) => setTrail((previous) => [...previous, next]);
  const title = current.kind === "inspection" ? "检测记录明细" : current.kind === "device" ? "设备检测记录" :
    current.kind === "order" ? (current.backer ? "Backer #" + current.backer : "KS 订单") : current.reference || "发货记录";
  return createPortal(<Dialog title={title} wide onClose={close}><div ref={content}>
    {trail.length > 1 && <button type="button" className="btn small shipping-detail-back"
      onClick={() => setTrail((previous) => previous.slice(0, -1))}><ArrowLeft size={14} />返回上一条</button>}
    {current.kind === "inspection" && <InspectionDetails key={current.record.id} record={current.record} request={request} open={open} />}
    {current.kind === "device" && <DeviceDetails key={current.serial} serial={current.serial} request={request} open={open} />}
    {current.kind === "shipment" && <ShipmentDetails key={current.id} id={current.id} request={request} open={open}
      navigation={shipmentNavigation} />}
    {current.kind === "order" && <OrderDetails key={current.id} id={current.id} request={request} open={open} />}
  </div></Dialog>, document.body);
}

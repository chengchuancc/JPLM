import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { Dialog } from "./dialog";
import { FieldVisibility } from "./material-table";
import { formatTime, RelatedRecordDialog, type RelatedTarget } from "./record-details";
import { CarrierTags, SourceTag, Status, Tracking, type Details, type Device, type ProductChoice, type Request, type ShipmentItem } from "./shipping-data";
import { canSaveItems, itemKey, itemPayload, ShipmentItemEditor, ShipmentItems } from "./shipping-items";
import { ShippingPicker } from "./shipping-options";
import { ShippingTableHeader } from "./shipping-table-header";
import { columnClass, productFields, shipmentColumns, type ShippingColumn } from "./shipping-columns";

type Project = { id: string; name: string; archived_at: string | null };
type Package = { id: string; project_id: string; project_name: string | null; reference: string; tracking: string;
  shipped_on: string; shipped: boolean; source: string; carrier: string; created_at: string; updated_at: string;
  details?: Details; devices?: Device[];
  shipment_items: ShipmentItem[]; can_open: boolean; can_edit: boolean };
type Order = { order_key: string; order_number: string; created_at: string; package_count: number;
  shipped_count: number; packages: Package[] };
type Page = { rows: Order[]; total: number; page_size: number; projects: Project[] };
function orderItems(packages: Package[]) {
  const totals = new Map<string, ShipmentItem>();
  for (const pack of packages) for (const item of pack.shipment_items) {
    const key = itemKey(item);
    totals.set(key, { ...item, quantity: item.quantity + (totals.get(key)?.quantity || 0) });
  }
  return [...totals.values()];
}

function PackageCell({ column, order, pack, items, open }: {
  column: ShippingColumn; order: Order; pack?: Package; items: ShipmentItem[];
  open: (pack: Package, target?: RelatedTarget) => void;
}) {
  const packages = pack ? [pack] : order.packages;
  const values = (select: (p: Package) => string | number | null | undefined) =>
    [...new Set(packages.map(select).filter((value) => value !== "" && value != null))];
  const key = column.key;
  if (column.product) {
    const quantity = items.find((item) => itemKey(item) === itemKey({ ...column.product!, quantity: 0 }))?.quantity;
    return <span className="shipping-quantity">{quantity ?? "—"}</span>;
  }
  if (key === "legacy_items") return <ShipmentItems items={items.filter((item) => !item.product_id)} />;
  if (key === "created_at") return <span>{formatTime(pack?.created_at || order.created_at)}</span>;
  if (key === "status") {
    return !pack && order.shipped_count > 0 && order.shipped_count < order.package_count
      ? <span className="shipping-status">部分发货</span> : <Status sent={pack ? !!pack.shipped : order.shipped_count > 0} />;
  }
  if (key === "source") {
    const sources = values((p) => p.source);
    return sources.length ? <div className="shipping-relation-cell">
      {sources.map((source) => <SourceTag key={source} value={source ?? undefined} />)}
    </div> : <>—</>;
  }
  if (key === "carrier") return <CarrierTags value={values((p) => p.carrier).join("、")} />;
  if (key === "tracking") {
    const tracking = values((p) => p.tracking);
    return <div className="shipping-relation-cell">
      <Tracking shipment={{ channel: "other", tracking: String(tracking[0] || ""), details: {} }} />
      {tracking.length > 1 && <small title={tracking.join("、")}>+{tracking.length - 1}</small>}
    </div>;
  }
  if (key === "devices") {
    const devices = packages.flatMap((p) => (p.devices || []).map((device) => ({ device, pack: p })));
    const first = devices[0];
    return first ? <div className="shipping-relation-cell">
      <button type="button" className="shipping-chip mono" title={first.device.serial}
        onClick={() => open(first.pack, { kind: "device", serial: first.device.serial })}>{first.device.serial.slice(0, 6)}</button>
      {devices.length > 1 && <small>+{devices.length - 1}</small>}
    </div> : <>—</>;
  }
  const fieldValues = values((p) => key === "shipped_on" ? p.shipped_on
    : key === "owner" ? p.project_name || "跨项目" : p.details?.[key]);
  return <span title={fieldValues.join("、")}>{fieldValues.length > 1 ? "多笔 · 展开查看" : fieldValues[0] ?? "—"}</span>;
}

function PackageEditor({ request, projectRequest, projects, item, order, onClose, onSaved }: {
  request: Request; projectRequest: (project: string) => Request; projects: Project[];
  item?: Package; order: string; onClose: () => void; onSaved: () => void;
}) {
  const writable = projects.filter((project) => !project.archived_at);
  const [project, setProject] = useState(item?.project_id || (writable.length === 1 ? writable[0].id : ""));
  const [reference, setReference] = useState(order);
  const [tracking, setTracking] = useState("");
  const [shippedOn, setShippedOn] = useState("");
  const [details, setDetails] = useState<Details>({});
  const [items, setItems] = useState(() => (item?.shipment_items || []).filter((line) =>
    writable.some((p) => p.id === line.project_id)));
  const locked = item?.shipment_items.filter((line) => !writable.some((p) => p.id === line.project_id)) || [];
  const [products, setProducts] = useState<ProductChoice[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request("global-shipping/products").then((result) => { if (active) setProducts(result); },
      (e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request]);
  const setField = (key: string, value: string) => setDetails((previous) => ({ ...previous, [key]: value }));
  return <Dialog title={item ? "编辑发货商品" : "登记发货"} onClose={() => { if (!busy) onClose(); }} wide>
    <form className="global-shipping-form" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !products || !project || !canSaveItems(items) || (!item && !reference.trim())) return;
      setBusy(true); setError("");
      try {
        const shipment_items = itemPayload(items);
        if (item) await request("global-shipping/packages/" + project + "/" + item.id + "/items", "PUT",
          { version: item.updated_at, shipment_items });
        else await request("global-shipping/packages", "POST",
          { project_id: project, reference, tracking, shipped_on: shippedOn, details, shipment_items });
        onSaved();
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      {!item && <div className="global-shipping-fields">
        <label>经办项目<select aria-label="经办项目" value={project} onChange={(event) => setProject(event.target.value)} required disabled={busy}>
          <option value="">选择项目</option>
          {writable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>订单号<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={150} required disabled={busy} /></label>
        <label>运单号<input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={500} disabled={busy} /></label>
        <label>发货日期<input type="date" value={shippedOn} onChange={(e) => setShippedOn(e.target.value)} disabled={busy} /></label>
        <label>发货状态<select aria-label="发货状态" value={String(details.shipment_status || "")} disabled={busy}
          onChange={(e) => setField("shipment_status", e.target.value)}>
          <option value="">自动</option><option value="shipped">已发货</option><option value="pending">待发货</option>
        </select></label>
        <label>收件人<input value={details.name || ""} onChange={(e) => setField("name", e.target.value)} disabled={busy} /></label>
        <label>地址<input value={details.address || ""} onChange={(e) => setField("address", e.target.value)} disabled={busy} /></label>
        <label>备注<input value={details.notes || ""} onChange={(e) => setField("notes", e.target.value)} disabled={busy} /></label>
        {project && <>
          <div>来源<ShippingPicker kind="sources" request={projectRequest(project)} value={details.source}
            disabled={busy} onChange={(value) => setField("source", value)} /></div>
          <div>货代 / 承运商<ShippingPicker kind="carriers" request={projectRequest(project)} value={details.carrier}
            disabled={busy} onChange={(value) => setField("carrier", value)} /></div>
          <div>国家 / 地区<ShippingPicker kind="country" request={projectRequest(project)} value={details.country}
            disabled={busy} onChange={(value) => setField("country", value)} /></div>
        </>}
      </div>}
      <h3>发货商品</h3>
      {products ? <ShipmentItemEditor products={products} items={items} onChange={(next) => {
        setItems(next);
        if (!project && next[0]) setProject(next[0].project_id);
      }} disabled={busy} showProject />
        : !error && <p className="muted">正在加载产品…</p>}
      {!!locked.length && <ShipmentItems items={locked} showProject />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn primary" type="submit" disabled={busy || !products || !project || !canSaveItems(items)}>保存</button>
      </div>
    </form>
  </Dialog>;
}

export default function GlobalShipping({ request, projectRequest, onDraftChange }: {
  request: Request; projectRequest: (project: string) => Request; onDraftChange: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<Page>();
  const [q, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<{ pack: Package; target: RelatedTarget }>();
  const [editor, setEditor] = useState<{ order: string; item?: Package }>();
  const [catalog, setCatalog] = useState<ProductChoice[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("plm-global-shipping-fields") || "[]");
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  });
  const projects = data?.projects || [];
  const canCreate = projects.some((p) => !p.archived_at);
  const history = data?.rows.flatMap((order) => order.packages.flatMap((pack) => pack.shipment_items)) || [];
  const available = shipmentColumns("other", productFields(
    catalog.filter((p) => !project || p.project_id === project),
    history.filter((p) => !project || p.project_id === project), true), true);
  const columns = available.filter((column) => column.fixed || !hidden.includes(column.key));
  const tableWidth = columns.reduce((total, column) => total + column.width, 171);
  function open(pack: Package, target?: RelatedTarget) {
    if (pack.can_open) setDetail({ pack, target: target || { kind: "shipment", id: pack.id, reference: pack.reference } });
  }
  useEffect(() => {
    onDraftChange(!!editor);
    return () => onDraftChange(false);
  }, [!!editor]);
  useEffect(() => {
    let active = true;
    setBusy(true); setError("");
    request("global-shipping/orders?" + new URLSearchParams({ q: search, project, status, page: String(page) }))
      .then((value) => { if (active) setData(value); }, (e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [request, search, project, status, page, revision]);
  useEffect(() => {
    let active = true;
    request("global-shipping/products").then((result) => { if (active) setCatalog(result); },
      () => { /* Product columns on the loaded records are still available. */ });
    return () => { active = false; };
  }, [request, revision]);
  return <section className="shipping-management">
    <div className="shipping-header"><h1>全局发货</h1></div>
    <div className="shipping-toolbar">
      <form className="shipping-tools global-shipping-search" onSubmit={(event) => {
        event.preventDefault(); setPage(1); setSearch(q.trim());
      }}>
        <input aria-label="搜索订单" placeholder="订单号、运单号或产品" value={q} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="btn"><Search size={15} />搜索</button>
      </form>
      <div className="shipping-tools global-shipping-filters">
        <FieldVisibility columns={available} hidden={hidden} onChange={(next) => {
          setHidden(next);
          try { localStorage.setItem("plm-global-shipping-fields", JSON.stringify(next)); }
          catch { /* Column changes still apply to the current view. */ }
        }} />
        <select aria-label="发货项目" value={project} onChange={(event) => { setProject(event.target.value); setPage(1); }}>
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="订单发货状态" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">全部状态</option><option value="shipped">已发货</option><option value="partial">部分发货</option>
          <option value="pending">待发货</option>
        </select>
        {canCreate && <button className="btn primary" type="button" onClick={() => setEditor({ order: "" })}>
          <Plus size={15} />登记发货
        </button>}
      </div>
    </div>
    {error && <p role="alert" className="form-error">{error} <button className="btn small" type="button"
      onClick={() => setRevision((value) => value + 1)}>重试</button></p>}
    <div className="table-wrap shipping-table global-shipping-table" aria-label="全局发货订单" aria-busy={busy}>
      <table style={{ width: tableWidth }}>
        <ShippingTableHeader columns={columns} index actionWidth={126} />
        <tbody>{data?.rows.map((order, index) => {
          const expanded = !!opened[order.order_key];
          const items = orderItems(order.packages);
          return <Fragment key={order.order_key}>
            <tr>
              <td className="shipping-row-index">{(page - 1) * (data?.page_size || 50) + index + 1}</td>
              {columns.map((column) => <td key={column.key} className={columnClass(column)}>
                {column.key === "reference" ? <button type="button" className="text-link global-order-toggle" aria-expanded={expanded}
                  onClick={() => setOpened((previous) => ({ ...previous, [order.order_key]: !expanded }))}>
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <strong className="mono">{order.order_number || "无订单号"}</strong><small>{order.package_count} 包</small>
                </button> : <PackageCell column={column} order={order} items={items} open={open} />}
              </td>)}
              <td className="shipping-row-action">
                {canCreate && order.order_number && <button className="btn small" type="button"
                  onClick={() => setEditor({ order: order.order_number })}><Plus size={14} />登记包裹</button>}
              </td>
            </tr>
            {expanded && order.packages.map((pack, i) => <tr className="shipping-child-row global-package-row" key={pack.project_id + "/" + pack.id}>
              <td className="shipping-row-index">{i + 1}</td>
              {columns.map((column) => <td key={column.key} className={columnClass(column)}>
                {column.key === "reference" ? <div className="shipping-hierarchy">
                  <span aria-hidden="true">↳</span>
                  {pack.can_open ? <button className="text-link mono" type="button" onClick={() => open(pack)}>
                    {pack.reference || "包裹 " + (i + 1)}</button> : <span>{pack.reference || "包裹 " + (i + 1)}</span>}
                </div> : <PackageCell column={column} order={order} pack={pack} items={pack.shipment_items} open={open} />}
              </td>)}
              <td className="shipping-row-action">
                {pack.can_edit && <button className="btn small" type="button" aria-label="编辑发货商品"
                  onClick={() => setEditor({ order: order.order_number, item: pack })}>商品</button>}
                {pack.can_open && <a className="btn small" href={"#projects/" + pack.project_id + "/shipping/" + pack.id}>项目台账</a>}
              </td>
            </tr>)}
          </Fragment>;
        })}</tbody>
      </table>
      {!error && !data?.rows.length && <p className="shipping-empty">{busy ? "正在加载…" : "暂无发货订单"}</p>}
    </div>
    <div className="shipping-count global-shipping-paging">
      <span>共 {data?.total || 0} 个订单</span>
      <button className="btn small" type="button" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <button className="btn small" type="button" disabled={busy || !data || page * data.page_size >= data.total}
        onClick={() => setPage(page + 1)}>下一页</button>
    </div>
    {detail && <RelatedRecordDialog target={detail.target} request={(path, method, payload) =>
      projectRequest(detail.pack.project_id)(path.startsWith("shipping/records/") ? path + "?scope=global" : path, method, payload)}
      close={() => setDetail(undefined)} />}
    {editor && <PackageEditor request={request} projectRequest={projectRequest} projects={projects} order={editor.order}
      item={editor.item} onClose={() => setEditor(undefined)} onSaved={() => {
        setEditor(undefined); setRevision((value) => value + 1);
      }} />}
  </section>;
}

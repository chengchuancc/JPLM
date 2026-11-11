import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight, Plus, Search, Trash2 } from "lucide-react";
import { Dialog } from "./dialog";
import { FieldVisibility } from "./material-table";
import { formatTime, RelatedRecordDialog, type RelatedTarget } from "./record-details";
import { CarrierTags, CountryTag, costs, otherContactFields, shipmentStatuses, SourceTag, Status, Tracking,
  type Details, type Device, type ProductChoice, type Request, type ShipmentItem } from "./shipping-data";
import { canSaveItems, itemPayload, ShipmentItemEditor, ShipmentItems } from "./shipping-items";
import { ShippingPicker } from "./shipping-options";
import { ShippingTableHeader } from "./shipping-table-header";
import { columnClass, groupedFields, type ShippingColumn } from "./shipping-columns";
import { restoreListPages, usePageState } from "./navigation";
import { useShipmentRowLocation } from "./shipping-location";
import { DevicePicker } from "./shipping-devices";
import { TableOptionPicker } from "./material-category";
import { OptionTag } from "./option-tag";

type Project = { id: string; name: string; archived_at: string | null };
type RecordRow = {
  id: string; project_id: string; project_name: string | null; reference: string; parent_id: string | null;
  tracking: string; shipped_on: string; shipped: boolean; source: string; carrier: string;
  created_at: string; updated_at: string; details?: Details; devices?: Device[];
  shipment_items: ShipmentItem[]; can_open: boolean; can_edit: boolean;
  handling_project_ids: string[];
};
type Order = { order_key: string; order_number: string; packages: RecordRow[] };
type Page = { rows: Order[]; total: number; page: number; page_size: number; projects: Project[];
  location?: { id: string; order_key: string } | null };
type Editor = { item?: RecordRow; parent?: RecordRow };
const columns = [
  ...groupedFields("order", [
    { key: "reference", label: "订单号", width: 145, fixed: true },
    { key: "name", label: "姓名", width: 108 },
    { key: "source", label: "来源", width: 100 },
    { key: "owner", label: "经办项目", width: 110 },
    { key: "created_at", label: "添加时间 ↓", width: 148 },
  ]),
  ...groupedFields("transport", [
    { key: "tracking", label: "跟踪链接", width: 145 },
    { key: "status", label: "发货进度", width: 82 },
    { key: "carrier", label: "物流平台", width: 108 },
    { key: "shipped_on", label: "发货日期", width: 116 },
    { key: "devices", label: "发货设备 S/N", width: 140 },
    ...costs.map(([key, label]) => ({ key, label, width: 100 })),
  ]),
  ...groupedFields("goods", [{ key: "shipment_items", label: "发货商品", width: 250 }]),
  ...groupedFields("customer", otherContactFields.filter(([key]) => key !== "name").map(([key, label]) =>
    ({ key, label, width: key === "country" ? 112 : 150 }))),
  ...groupedFields("notes", [{ key: "notes", label: "备注", width: 180 }]),
];
const defaultHidden = ["source", "owner", "created_at", "devices", "shipped_on", "email", "address2", ...costs.map(([key]) => key)];

function orderRows(order: Order) {
  const records = order.packages;
  const root = records.find((record) => !record.parent_id && records.some((other) => other.parent_id === record.id))
    || records.find((record) => !record.parent_id) || records[0];
  if (!root) return [];
  const ids = new Set(records.map((record) => record.id));
  const byParent = new Map<string, RecordRow[]>();
  for (const record of records) {
    if (record === root) continue;
    const parent = record.parent_id && ids.has(record.parent_id) ? record.parent_id : root.id;
    const children = byParent.get(parent) || [];
    children.push(record);
    byParent.set(parent, children);
  }
  const ordered: { row: RecordRow; depth: number }[] = [];
  function append(row: RecordRow, depth: number) {
    ordered.push({ row, depth });
    for (const child of byParent.get(row.id) || []) append(child, depth + 1);
  }
  append(root, 0);
  return ordered;
}

function recordProjects(row: RecordRow) {
  return new Set([row.project_id, ...(row.handling_project_ids || []), ...row.shipment_items.map((item) => item.project_id)]);
}

function RecordCell({ column, row, projects, open }: {
  column: ShippingColumn; row: RecordRow; projects: Project[]; open: (target: RelatedTarget) => void;
}) {
  const key = column.key;
  if (key === "shipment_items") return <button type="button" className="shipping-items-open" aria-label="查看发货商品"
    onClick={() => open({ kind: "shipment", id: row.id, reference: row.reference })}>
    <ShipmentItems items={row.shipment_items} showProject flagEmpty />
  </button>;
  if (key === "created_at") return <span>{formatTime(row.created_at)}</span>;
  if (key === "status") return <Status sent={!!row.shipped} />;
  if (key === "source") return <SourceTag value={row.source} />;
  if (key === "carrier") return <CarrierTags value={row.carrier} />;
  if (key === "country") return <CountryTag value={row.details?.country} />;
  if (key === "tracking") return <Tracking shipment={{ channel: "other", tracking: row.tracking, details: {} }} />;
  if (key === "devices") {
    const first = row.devices?.[0];
    return first ? <div className="shipping-relation-cell">
      <button type="button" className="shipping-chip mono" title={first.serial}
        onClick={() => open({ kind: "device", serial: first.serial })}>{first.serial.slice(0, 6)}</button>
      {row.devices!.length > 1 && <small>+{row.devices!.length - 1}</small>}
    </div> : <>—</>;
  }
  if (key === "owner") {
    const related = recordProjects(row);
    return <span className="shipping-carrier-tags">{projects.filter((p) => related.has(p.id)).map((p) =>
      <OptionTag key={p.id} label={p.name} />)}</span>;
  }
  const value = key === "shipped_on" ? row.shipped_on : row.details?.[key];
  return <span title={String(value ?? "")}>{value === "" || value == null ? "—" : value}</span>;
}

function OrderEditor({ request, projectRequest, projects, products, editor, close, saved }: {
  request: Request; projectRequest: (project: string) => Request; projects: Project[]; products: ProductChoice[];
  editor: Editor; close: () => void; saved: (id: string) => void;
}) {
  const { item, parent } = editor;
  const writable = projects.filter((p) => !p.archived_at);
  const fixedProject = item?.project_id || parent?.project_id;
  const [selected, setSelected] = useState(() => {
    const record = item || parent;
    return record ? [...recordProjects(record)] : writable.length === 1 ? [writable[0].id] : [];
  });
  const project = fixedProject || selected[0] || "";
  const [reference, setReference] = useState(item?.reference ?? parent?.reference ?? "");
  const [tracking, setTracking] = useState(item?.tracking || "");
  const [shippedOn, setShippedOn] = useState(item?.shipped_on || "");
  const [devices, setDevices] = useState(item?.devices || []);
  const [details, setDetails] = useState<Details>(() => {
    if (item) return { ...item.details };
    if (!parent) return {};
    return Object.fromEntries([...otherContactFields, ["source"]].flatMap(([key]) =>
      parent.details?.[key] === undefined ? [] : [[key, parent.details[key]]]));
  });
  const [items, setItems] = useState(() => (item?.shipment_items || []).filter((line) =>
    writable.some((p) => p.id === line.project_id)));
  const locked = item?.shipment_items.filter((line) => !writable.some((p) => p.id === line.project_id)) || [];
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectOption = writable.find((p) => p.id === project);
  const selectedNames = projects.filter((p) => selected.includes(p.id)).map((p) => p.name);
  const scopedProducts = products.filter((p) => selected.includes(p.project_id));
  const setField = (key: string, value: string) => setDetails((previous) => ({ ...previous, [key]: value }));
  const title = item ? "编辑发货" : parent ? "登记补发子订单" : "登记发货";
  return <Dialog title={title} onClose={() => { if (!busy) close(); }} wide>
    <form className="global-shipping-form" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !project || !canSaveItems(items) || (!item && !reference.trim())) return;
      setBusy(true); setError("");
      try {
        const path = "global-shipping/orders" + (item ? "/" + project + "/" + item.id : "");
        const row = await request(path, item ? "PUT" : "POST", {
          project_id: project, reference, tracking, shipped_on: shippedOn, details,
          handling_project_ids: writable.filter((p) => selected.includes(p.id)).map((p) => p.id),
          shipment_items: itemPayload(items), devices: devices.map((device) => device.serial),
          version: item?.updated_at, parent_id: parent?.id,
        });
        saved(row.id);
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      <div className="global-shipping-fields">
        <label>订单号<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={150} required={!item} disabled={busy} /></label>
        <label>姓名<input value={details.name || ""} onChange={(e) => setField("name", e.target.value)} disabled={busy} /></label>
        <label>运单号<input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={500} disabled={busy} /></label>
        <div>发货进度<TableOptionPicker label="发货进度" value={String(details.shipment_status || "")} disabled={busy}
          choices={[{ value: "", label: "自动", tone: "slate" }, ...shipmentStatuses]}
          onChange={(value) => setField("shipment_status", value)} /></div>
        <label>发货日期<input type="date" value={shippedOn} onChange={(e) => setShippedOn(e.target.value)} disabled={busy} /></label>
        <div className="global-handling-projects">
          <span>经办项目</span>
          <details className="shipping-multi-picker">
            <summary className="btn" aria-label="选择经办项目"><ChevronDown size={14} />
              <span title={selectedNames.join("、")}>{selectedNames.join("、") || "选择经办项目"}</span>
            </summary>
            <div className="shipping-multi-options shipping-multi-list">
              {projects.map((p) => {
                const hasGoods = items.some((line) => line.project_id === p.id);
                return <label key={p.id}>
                  <input type="checkbox" checked={selected.includes(p.id)}
                    disabled={busy || !!p.archived_at || p.id === fixedProject || hasGoods}
                    onChange={(event) => {
                      const next = event.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id);
                      if ((fixedProject || next[0]) !== project) setDevices([]);
                      setSelected(next);
                    }} />
                  <span><OptionTag label={p.name} />{p.id === project && <small> · 主项目</small>}
                    {p.id !== project && hasGoods && <small> · 已选商品</small>}</span>
                </label>;
              })}
            </div>
          </details>
        </div>
        {project && <>
          <div>国家 / 地区<ShippingPicker kind="country" request={projectRequest(project)} value={details.country}
            disabled={busy} onChange={(value) => setField("country", value)} /></div>
          <div>物流平台<ShippingPicker kind="carriers" request={projectRequest(project)} value={details.carrier}
            disabled={busy} onChange={(value) => setField("carrier", value)} /></div>
          <div>来源<ShippingPicker kind="sources" request={projectRequest(project)} value={details.source}
            disabled={busy} onChange={(value) => setField("source", value)} /></div>
        </>}
        {otherContactFields.filter(([key]) => key !== "name" && key !== "country").map(([key, label]) =>
          <label key={key}>{label}<input value={details[key] ?? ""} onChange={(e) => setField(key, e.target.value)} disabled={busy} /></label>)}
      </div>
      <h3>发货商品</h3>
      {selected.length ? <ShipmentItemEditor products={scopedProducts} items={items} onChange={setItems}
        disabled={busy} showProject multi unknownProject={projectOption} />
        : <p className="muted">请先选择经办项目</p>}
      {!!locked.length && <ShipmentItems items={locked} showProject />}
      {project && <details className="global-order-extra"><summary>发货设备{devices.length ? " · " + devices.length + " 台" : ""}</summary>
        <DevicePicker key={project} request={projectRequest(project)} devices={devices} setDevices={setDevices} />
      </details>}
      <details className="global-order-extra"><summary>费用与备注</summary>
        <div className="global-shipping-fields">
          {costs.map(([key, label]) => <label key={key}>{label}<input type="number" min={0} step="any"
            value={details[key] ?? ""} onChange={(e) => setField(key, e.target.value)} disabled={busy} /></label>)}
          <label>备注<textarea rows={2} value={details.notes || ""} onChange={(e) => setField("notes", e.target.value)} disabled={busy} /></label>
        </div>
      </details>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" type="button" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" type="submit" disabled={busy || !project || !canSaveItems(items)}>保存</button>
      </div>
    </form>
  </Dialog>;
}

export default function GlobalShipping({ request, projectRequest, onDraftChange, initialRecord = "" }: {
  request: Request; projectRequest: (project: string) => Request; onDraftChange: (dirty: boolean) => void; initialRecord?: string;
}) {
  const [visited, setVisited] = usePageState("global-shipping.visited", false);
  const restored = useRef(visited).current;
  const [data, setData] = useState<Page>();
  const [q, setQuery] = usePageState("global-shipping.q", "");
  const [search, setSearch] = usePageState("global-shipping.search", "");
  const [project, setProject] = usePageState("global-shipping.project", "");
  const [status, setStatus] = usePageState("global-shipping.status", "");
  const [range, setRange] = usePageState("global-shipping.range", { first: 1, last: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [opened, setOpened] = usePageState<Record<string, boolean>>("global-shipping.opened", {});
  const [detail, setDetail] = usePageState<{ target: RelatedTarget; project: string; full: boolean } | undefined>("global-shipping.detail", undefined, false);
  const [editor, setEditor] = useState<Editor>();
  const [catalog, setCatalog] = useState<ProductChoice[]>([]);
  const [focused, setFocused] = usePageState("global-shipping.focused", initialRecord);
  const pending = useRef(restored ? "" : initialRecord);
  const restoreRange = useRef(restored ? range : null);
  const restoredFocus = useRef(restored ? focused : "");
  const grid = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const moreRequest = useRef(false);
  const scrollAnchor = useRef<{ height: number; top: number }>(undefined);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("plm-global-order-columns") || "null");
      return Array.isArray(value) ? value : defaultHidden;
    } catch { return defaultHidden; }
  });
  const projects = data?.projects || [];
  const canCreate = projects.some((p) => !p.archived_at);
  const displayed = columns.filter((column) => column.fixed || !hidden.includes(column.key));
  const tableWidth = displayed.reduce((total, column) => total + column.width, 156);
  useShipmentRowLocation(grid, focused, !!data && !busy && (!restored || focused !== restoredFocus.current));
  function open(row: RecordRow, target?: RelatedTarget) {
    const scope = row.can_open ? row.project_id : row.shipment_items[0]?.project_id || row.handling_project_ids?.[0];
    if (scope) setDetail({ project: scope, full: row.can_open,
      target: target || { kind: "shipment", id: row.id, reference: row.reference } });
  }
  useEffect(() => {
    onDraftChange(!!editor);
    return () => onDraftChange(false);
  }, [!!editor]);
  useEffect(() => {
    let active = true;
    const epoch = ++generation.current;
    moreRequest.current = false;
    scrollAnchor.current = undefined;
    setBusy(true); setError(""); setMoreError(""); setLoadingMore(false);
    const query = new URLSearchParams({ q: search, project, status });
    if (pending.current) query.set("locate", pending.current);
    const savedRange = restoreRange.current;
    restoreListPages(savedRange, (number) => {
      if (number !== undefined) query.set("page", String(number));
      return request("global-shipping/orders?" + query) as Promise<Page>;
    }, (row) => row.order_key).then((value) => {
      if (!active) return;
      restoreRange.current = null;
      setVisited(true);
      if (value.location) {
        pending.current = "";
        const group = value.rows.find((row) => row.order_key === value.location!.order_key);
        if (group && orderRows(group)[0]?.row.id !== value.location.id) {
          setOpened((previous) => ({ ...previous, [value.location!.order_key]: true }));
        }
      }
      setRange(savedRange || { first: value.page, last: value.page });
      setData(value);
    }, (e) => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; if (epoch === generation.current) generation.current++; };
  }, [request, search, project, status, revision]);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const container = grid.current;
    if (anchor && container) {
      container.scrollTop = anchor.top + container.scrollHeight - anchor.height;
      scrollAnchor.current = undefined;
    }
  }, [data?.rows]);
  useEffect(() => {
    if (!data || busy || loadingMore || moreError || error) return;
    const hasEarlier = range.first > 1;
    const hasLater = range.last * data.page_size < data.total;
    if (!hasEarlier && !hasLater) return;
    const observer = new IntersectionObserver((entries) => {
      if (moreRequest.current) return;
      const direction = entries.some((entry) => entry.isIntersecting && entry.target === top.current) ? -1
        : entries.some((entry) => entry.isIntersecting && entry.target === tail.current) ? 1 : 0;
      if (!direction) return;
      const target = direction === -1 ? range.first - 1 : range.last + 1;
      const epoch = generation.current;
      moreRequest.current = true;
      setLoadingMore(true);
      const query = new URLSearchParams({ q: search, project, status, page: String(target) });
      request("global-shipping/orders?" + query).then((next: Page) => {
        if (epoch !== generation.current) return;
        if (direction < 0 && grid.current) {
          scrollAnchor.current = { height: grid.current.scrollHeight, top: grid.current.scrollTop };
        }
        setData((current) => {
          if (!current) return next;
          const fetched = new Set(next.rows.map((row) => row.order_key));
          const retained = current.rows.filter((row) => !fetched.has(row.order_key));
          return { ...next, rows: direction < 0 ? [...next.rows, ...retained] : [...retained, ...next.rows] };
        });
        setRange((current) => direction < 0 ? { ...current, first: target } : { ...current, last: target });
      }, (e) => { if (epoch === generation.current) setMoreError(e.message); }).finally(() => {
        if (epoch === generation.current) { moreRequest.current = false; setLoadingMore(false); }
      });
    }, { root: grid.current, rootMargin: "100px 0px 200px 0px" });
    if (hasEarlier && top.current) observer.observe(top.current);
    if (hasLater && tail.current) observer.observe(tail.current);
    return () => observer.disconnect();
  }, [data, busy, loadingMore, moreError, error, range, request, search, project, status]);
  useEffect(() => {
    let active = true;
    request("global-shipping/products").then((result) => { if (active) setCatalog(result); },
      (e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request, revision]);

  function resetFocus() { restoreRange.current = null; pending.current = ""; setFocused(""); grid.current?.scrollTo({ top: 0 }); }
  function afterSave(id: string) {
    setEditor(undefined); setNotice("发货记录已保存");
    setSearch(""); setQuery(""); setProject(""); setStatus("");
    pending.current = id; setFocused(id); setRevision((value) => value + 1);
  }
  async function remove(row: RecordRow) {
    if (deleting || !window.confirm("删除「" + (row.reference || "此订单") + "」？可在项目台账的「已删除」中恢复。")) return;
    setDeleting(true); setError(""); setNotice("");
    try {
      await request("global-shipping/orders/" + row.project_id + "/" + row.id, "DELETE", { version: row.updated_at });
      if (focused === row.id) setFocused("");
      const next = data?.rows.flatMap((order) => order.packages).find((candidate) => candidate.id !== row.id);
      pending.current = next?.id || "";
      setRevision((value) => value + 1);
      setNotice("已删除，可在项目台账的「已删除」中恢复");
    } catch (e) { setError((e as Error).message); }
    finally { setDeleting(false); }
  }
  return <section className="shipping-management">
    <div className="shipping-header"><h1>全局发货</h1></div>
    <div className="shipping-toolbar">
      <form className="shipping-tools" onSubmit={(event) => {
        event.preventDefault(); resetFocus(); setSearch(q.trim());
      }}>
        <input aria-label="搜索订单" placeholder="订单号、姓名、运单号或商品" value={q} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="btn"><Search size={15} />搜索</button>
      </form>
      <div className="shipping-tools global-shipping-filters">
        <FieldVisibility columns={columns} hidden={hidden} onChange={(next) => {
          setHidden(next);
          try { localStorage.setItem("plm-global-order-columns", JSON.stringify(next)); }
          catch { /* Column changes still apply to the current view. */ }
        }} />
        <TableOptionPicker label="发货项目" value={project} onChange={(value) => { resetFocus(); setProject(value); }}
          choices={[{ value: "", label: "全部项目", tone: "slate" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
        <TableOptionPicker label="订单发货状态" value={status} onChange={(value) => { resetFocus(); setStatus(value); }}
          choices={[{ value: "", label: "全部状态", tone: "slate" }, ...shipmentStatuses]} />
        {canCreate && <button className="btn primary" type="button" onClick={() => { setNotice(""); setEditor({}); }}>
          <Plus size={15} />登记发货
        </button>}
      </div>
    </div>
    {notice && <p className="shipping-notice" role="status">{notice}</p>}
    {error && <p role="alert" className="form-error">{error} <button className="btn small" type="button"
      onClick={() => { resetFocus(); setRevision((value) => value + 1); }}>刷新</button></p>}
    <div className="table-wrap shipping-table global-shipping-table" ref={grid} aria-label="全局发货订单" aria-busy={busy}>
      <div ref={top} className="shipping-scroll-sentinel" aria-hidden="true" />
      <table style={{ width: tableWidth }}>
        <ShippingTableHeader columns={displayed} index actionWidth={111} />
        <tbody>{data?.rows.map((order, index) => {
          const records = orderRows(order);
          const hasChildren = records.length > 1;
          const root = records[0]?.row;
          const term = search.replace(/^#/, "").toLowerCase();
          const rootMatchesSearch = !term || !!root && [root.reference, root.tracking, root.details?.name,
            ...root.shipment_items.flatMap((item) => [item.name, item.code])].some((value) =>
            String(value ?? "").toLowerCase().includes(term));
          const rootMatchesStatus = !status || !!root?.shipped === (status === "shipped");
          const expanded = hasChildren && (opened[order.order_key] ?? (!rootMatchesSearch || !rootMatchesStatus));
          return <Fragment key={order.order_key}>{(expanded ? records : records.slice(0, 1)).map(({ row, depth }, subIndex) =>
            <tr key={row.id} data-shipment-id={row.id}
              className={[depth && "shipping-child-row", row.id === focused && "shipping-located-row"].filter(Boolean).join(" ")}>
              <td className="shipping-row-index">{depth ? <CornerDownRight size={13} aria-label="子订单" />
                : (range.first - 1) * (data?.page_size || 50) + index + 1}</td>
              {displayed.map((column) => <td key={column.key} className={columnClass(column)}>
                {column.key === "reference" ? <div className="shipping-hierarchy" style={{ paddingLeft: Math.min(depth, 2) * 8 }}>
                  {!depth && hasChildren && <button type="button" className="shipping-icon-btn" aria-expanded={expanded}
                    aria-label={(expanded ? "收起子订单：" : "展开子订单：") + order.order_number}
                    onClick={() => setOpened((previous) => ({ ...previous, [order.order_key]: !expanded }))}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>}
                  <button type="button" className="text-link mono shipping-reference" onClick={() => open(row)}>
                    {row.reference || (!depth ? order.order_number || "无订单号" : "子订单 " + subIndex)}
                  </button>
                  {!depth && hasChildren && <span className="shipping-child-count" title={records.length - 1 + " 个子订单"}>{records.length - 1}</span>}
                </div> : <RecordCell column={column} row={row} projects={projects} open={(target) => open(row, target)} />}
              </td>)}
              <td className="shipping-row-action">
                {row.can_edit && <>
                  <button className="btn small" type="button" disabled={deleting} onClick={() => setEditor({ item: row })}>编辑</button>
                  <button className="btn small shipping-icon-btn" type="button" disabled={deleting}
                    aria-label="新增子订单" title="登记补发子订单" onClick={() => setEditor({ parent: row })}><Plus size={14} /></button>
                  <button className="btn small shipping-icon-btn shipping-delete" type="button" disabled={deleting}
                    aria-label="删除" title="删除" onClick={() => void remove(row)}><Trash2 size={13} /></button>
                </>}
              </td>
            </tr>)}</Fragment>;
        })}</tbody>
      </table>
      {!error && !data?.rows.length && <p className="shipping-empty">{busy ? "正在加载…" : "暂无发货订单"}</p>}
      <div ref={tail} className="shipping-scroll-sentinel" aria-hidden="true" />
    </div>
    <div className="shipping-count global-shipping-paging">
      <span role="status">已显示 {data?.rows.length || 0} / {data?.total || 0} 个订单{loadingMore ? " · 加载中…" : ""}</span>
      {moreError && <button className="btn small" type="button" onClick={() => setMoreError("")}>加载失败，重试</button>}
    </div>
    {detail && <RelatedRecordDialog target={detail.target} request={(path, method, payload) =>
      projectRequest(detail.project)(detail.full && path.startsWith("shipping/records/") ? path + "?scope=global" : path, method, payload)}
      close={() => setDetail(undefined)} shipmentNavigation={(row) => {
        const scopes = new Set([detail.project, row.project_id, ...(row.handling_project_ids || []),
          ...row.shipment_items.map((item) => item.project_id)]);
        return projects.filter((p) => scopes.has(p.id)).map((p) => <a className="btn small" key={p.id}
          href={"#projects/" + p.id + "/shipping/" + row.id}>定位到 {p.name}</a>);
      }} />}
    {editor && <OrderEditor request={request} projectRequest={projectRequest} projects={projects} products={catalog}
      editor={editor} close={() => setEditor(undefined)} saved={afterSave} />}
  </section>;
}

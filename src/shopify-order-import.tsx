import { useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog";
import { formatTime } from "./record-details";
import type { Request } from "./shipping-data";

type Preview = {
  id: string;
  reference: string;
  created_at: string;
  recipient: string | null;
  fulfillment_status: string;
  reason: string;
};
type Page = { rows: Preview[]; cursor: string | null };
type Result = {
  created: { id: string; record_id: string }[];
  skipped: { id: string; reason: string }[];
};
const path = "global-shipping/shopify/orders";
const limit = 20;
const fulfillment: Record<string, string> = {
  FULFILLED: "已发货",
  UNFULFILLED: "未发货",
  PARTIALLY_FULFILLED: "部分发货",
  IN_PROGRESS: "处理中",
  ON_HOLD: "暂停发货",
  SCHEDULED: "已安排",
  REQUEST_DECLINED: "请求被拒绝",
};

export function ShopifyOrderImport({ request, close, imported }: {
  request: Request;
  close: () => void;
  imported: (count: number, complete: boolean) => void;
}) {
  const [rows, setRows] = useState<Preview[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [initial, setInitial] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function load(after?: string) {
    setLoading(true);
    setError("");
    try {
      const page: Page = await request(path + (after ? "?" + new URLSearchParams({ cursor: after }) : ""));
      setRows((previous) => after
        ? [...previous, ...page.rows.filter((row) => !previous.some(({ id }) => id === row.id))]
        : page.rows);
      setCursor(page.cursor);
      setInitial(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function confirm() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setResult("");
    try {
      const response: Result = await request(path, "POST", { ids: selected });
      const changes = new Map(response.skipped.map(({ id, reason }) => [id, reason]));
      response.created.forEach(({ id }) => changes.set(id, "已导入"));
      setRows((previous) => previous.map((row) => ({ ...row, reason: changes.get(row.id) || row.reason })));
      setSelected([]);
      const count = response.created.length;
      if (response.skipped.length) setResult(`已导入 ${count} 笔，跳过 ${response.skipped.length} 笔。原因见表格。`);
      if (count) imported(count, !response.skipped.length);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <Dialog title="导入 Shopify 订单" wide onClose={() => { if (!savingRef.current) close(); }}>
    <div className="global-shipping-form">
      {!!rows.length && <div className="table-wrap shopify-order-preview" aria-label="Shopify 订单预览">
        <table>
          <thead><tr><th scope="col">选择</th><th scope="col">订单号</th><th scope="col">下单时间</th>
            <th scope="col">收件人</th><th scope="col">发货状态</th><th scope="col">导入状态</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><input type="checkbox" aria-label={`选择订单 ${row.reference}`} checked={selected.includes(row.id)}
              disabled={saving || !!row.reason || (selected.length >= limit && !selected.includes(row.id))}
              onChange={(event) => setSelected((previous) => event.target.checked
                ? [...previous, row.id] : previous.filter((id) => id !== row.id))} /></td>
            <td>{row.reference}</td><td>{formatTime(row.created_at)}</td><td>{row.recipient || "—"}</td>
            <td>{fulfillment[row.fulfillment_status] || row.fulfillment_status}</td><td>{row.reason || "可导入"}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {loading && <p role="status" className="muted">正在读取 Shopify 订单…</p>}
      {!initial && !loading && !rows.length && <p className="muted">没有可显示的订单。</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {result && <p role="status" className="shipping-notice">{result}</p>}
      <div className="dialog-actions">
        {initial && error && !loading && <button className="btn" type="button" onClick={() => void load()}>重试</button>}
        {cursor && <button className="btn" type="button" disabled={loading || saving} onClick={() => void load(cursor)}>加载更早订单</button>}
        <span className="muted">已选 {selected.length} / {limit} 笔</span>
        <button className="btn" type="button" disabled={saving} onClick={close}>关闭</button>
        <button className="btn primary" type="button" disabled={!selected.length || saving || loading}
          onClick={() => void confirm()}>{saving ? "正在导入…" : "确认导入"}</button>
      </div>
    </div>
  </Dialog>;
}

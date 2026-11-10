export type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
export type Channel = "ks" | "other";
export type Details = Record<string, string | number>;
export type Order = { id: string; backer: string; details: Details; shipped: number; shipments: number };
export type Device = { serial: string; registered?: boolean; result?: string; shipments?: string };
export type Shipment = {
  id: string; channel: Channel; reference: string; ks_order_id: string | null; backer: string | null;
  shipped_on: string; tracking: string; details: Details; order_details: Details; operator: string | null;
  created_at: string; updated_at: string; devices: Device[]; source_id: string | null;
};
export type Page = { rows: (Order | Shipment)[]; total: number; page: number; page_size: number };
export const path = "shipping/";
export const contactFields = [
  ["name", "收件人"], ["phone", "电话"], ["email", "邮箱"], ["country", "国家 / 地区"],
  ["region", "州 / 省"], ["city", "城市"], ["postcode", "邮编"],
  ["address", "地址"], ["address2", "地址补充"],
];
export const items = [["main_unit", "主机"], ["base", "底座"], ["case", "收纳包"], ["strip", "条形反光贴"], ["patch", "块状反光贴"]];
export const costs = [["domestic_cost", "国内运费"], ["international_cost", "海外运费"], ["warehouse_cost", "海外仓运费"], ["weight", "包裹重量（g）"]];
export const orderFields = [...contactFields, ["country_code", "国家代码"], ["pb", "PB 编号"], ["sku", "SKU"],
  ["address_status", "地址确认"], ["pledged", "KS 承诺金额"], ["amount_due", "KS 应付金额"], ["paid", "已支付金额"],
  ["balance", "欠款"], ["notes", "备注"], ...items];
export const sources = ["Shopify", "Amazon", "Indiegogo", "AliExpress", "经销商", "KOL", "其他"];
export const isOrder = (row: Order | Shipment): row is Order => "shipments" in row;

export function Status({ sent }: { sent: boolean }) {
  return <span className={"shipping-status" + (sent ? " sent" : "")}>{sent ? "已发货" : "待发货"}</span>;
}

export function DetailsList({ fields, details, showEmpty }: { fields: string[][]; details: Details; showEmpty?: boolean }) {
  return <dl className="shipping-details">{fields.filter(([key]) => showEmpty || (details[key] !== undefined && details[key] !== ""))
    .map(([key, label]) => <div key={key} className={key.startsWith("address") || key === "notes" ? "wide-field" : ""}>
      <dt>{label}</dt><dd>{details[key] === "" ? "—" : details[key] ?? "—"}</dd>
    </div>)}</dl>;
}

export function Tracking({ shipment }: { shipment: Shipment }) {
  if (!shipment.tracking) return <>—</>;
  const address = "https://t.17track.net/en#nums=" + encodeURIComponent(shipment.tracking);
  return <a className="text-link mono" href={address} target="_blank" rel="noreferrer">{shipment.tracking}</a>;
}

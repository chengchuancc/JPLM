import { contactFields, costs, items, otherContactFields, type Channel, type ProductChoice, type ShipmentItem } from "./shipping-data";
import type { ShippingGroup } from "./shipping-table-header";

type ProductColumn = Pick<ShipmentItem, "project_id" | "name" | "code" | "project_name"> & { product_id: string };
export type ShippingField = {
  key: string; label: string; width: number; fixed?: boolean; type?: "date" | "number" | "quantity";
  product?: ProductColumn; hint?: string;
};
export type ShippingColumn = ShippingField & { group: ShippingGroup };
export const fieldColumns = (fields: string[][], width: number, type?: ShippingField["type"]): ShippingField[] =>
  fields.map(([key, label]) => ({ key, label, width, type }));
export const groupedFields = (group: ShippingGroup, fields: ShippingField[]): ShippingColumn[] =>
  fields.map((field) => ({ ...field, group }));
export const createdColumn: ShippingField = { key: "created_at", label: "添加时间 ↓", width: 151 };
export const ksGoodsColumns = [...fieldColumns(items, 88, "quantity"), ...fieldColumns([["sku", "SKU"]], 135)];
export const columnClass = (column: ShippingColumn) =>
  column.fixed ? "shipping-record-key" : column.group === "goods" ? "shipping-goods" : "";

export function productFields(catalog: ProductChoice[], history: ShipmentItem[], global = false): ShippingField[] {
  const products = new Map<string, ShippingField>();
  function add(product: ProductColumn) {
    const key = "product:" + product.project_id + ":" + product.product_id;
    if (products.has(key)) return;
    products.set(key, { key, label: product.name, width: global ? 114 : 100, type: "quantity", product,
      hint: [global ? product.project_name : undefined, product.code].filter(Boolean).join(" / ") });
  }
  for (const p of catalog) add({ ...p, product_id: p.id });
  for (const p of history) if (p.product_id) add({ ...p, product_id: p.product_id });
  const fields = [...products.values()];
  if (history.some((item) => !item.product_id)) fields.push({ key: "legacy_items", label: "未关联商品", width: 180 });
  return fields;
}

export function shipmentColumns(channel: Channel, goods: ShippingField[] = [], global = false): ShippingColumn[] {
  const contacts = channel === "ks" ? contactFields : otherContactFields;
  return [
    ...groupedFields("order", [
      { key: "reference", label: channel === "ks" ? "发货编号" : "订单号", width: 170, fixed: true },
      createdColumn,
      { key: channel === "ks" ? "backer" : "source", label: channel === "ks" ? "Backer 编号" : "来源", width: 120 },
      ...(global ? [{ key: "owner", label: "经办项目", width: 110 }] : []),
    ]),
    ...groupedFields("transport", [
      { key: "devices", label: "发货设备 S/N", width: 146 },
      { key: "shipped_on", label: "发货日期", width: 135, type: "date" },
      { key: "tracking", label: "运单号", width: 175 },
      { key: "status", label: "发货状态", width: 94 },
      { key: "carrier", label: "货代 / 承运商", width: 190 },
      ...fieldColumns(costs, 100, "number"),
    ]),
    ...groupedFields("goods", channel === "ks" ? ksGoodsColumns : goods),
    ...groupedFields("customer", contacts.map(([key, label]) => ({
      key, label, width: key === "name" || key === "country" ? 125 : 158,
    }))),
    ...groupedFields("notes", [{ key: "notes", label: "备注", width: 192 }]),
  ];
}

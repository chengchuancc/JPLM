import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { ProductChoice, ShipmentItem } from "./shipping-data";

export function itemKey(item: ShipmentItem) {
  return item.project_id + "/" + (item.product_id || item.legacy_key);
}

export function itemPayload(items: ShipmentItem[]) {
  return items.filter((item) => item.product_id).map(({ project_id, product_id, quantity }) =>
    ({ project_id, product_id, quantity }));
}

export function ShipmentItems({ items, links = false, showProject = false }: {
  items: ShipmentItem[]; links?: boolean; showProject?: boolean;
}) {
  if (!items.length) return <span className="muted">—</span>;
  return <span className="shipping-item-tags">{items.map((item) => {
    const name = (showProject && item.project_name ? item.project_name + " / " : "") + item.name + " × " + item.quantity;
    return links && item.product_id && item.available ?
      <a key={itemKey(item)} className="shipping-chip" href={"#projects/" + item.project_id + "/products/" + item.product_id}
        title={item.code}>{name}</a> :
      <span key={itemKey(item)} className="shipping-chip" title={item.code}>{name}{!item.product_id ? "（待关联）" : ""}</span>;
  })}</span>;
}

export function ShipmentItemEditor({ products, items, onChange, showProject, disabled }: {
  products: ProductChoice[]; items: ShipmentItem[]; onChange: (items: ShipmentItem[]) => void;
  showProject?: boolean; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("");
  const [legacy, setLegacy] = useState("");
  const used = new Set(items.filter((item) => item.product_id).map(itemKey));
  const key = (p: ProductChoice) => p.project_id + "/" + p.id;
  const matches = products.filter((p) => !used.has(key(p)) && [p.name, p.code, p.english_code, p.project_name]
    .filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  function add() {
    const product = matches.find((p) => key(p) === selection);
    if (!product) return;
    const replaced = items.find((item) => item.legacy_key === legacy);
    onChange([...items.filter((item) => item !== replaced), { product_id: product.id, project_id: product.project_id,
      project_name: product.project_name, name: product.name, code: product.code, available: true, quantity: replaced?.quantity || 1 }]);
    setSelection("");
    setLegacy("");
  }
  return <div className="shipping-item-editor">
    {items.map((item) => <div key={itemKey(item)} className="shipping-item-edit-row">
      <span><strong>{item.name}</strong>{showProject && item.project_name && <small>{item.project_name}</small>}</span>
      {item.product_id ? <>
        <input type="number" aria-label={item.name + "数量"} min={1} max={1000000000} step={1}
          disabled={disabled} value={item.quantity || ""} onChange={(event) => onChange(items.map((line) => line === item ?
            { ...line, quantity: event.target.valueAsNumber || 0 } : line))} />
        <button type="button" className="shipping-icon-btn" disabled={disabled} aria-label={"移除" + item.name}
          onClick={() => onChange(items.filter((line) => line !== item))}><X size={15} /></button>
      </> : <>
        <span className="muted">{item.quantity} 件</span>
        <button type="button" className="btn small" disabled={disabled} aria-pressed={legacy === item.legacy_key}
          onClick={() => setLegacy(item.legacy_key || "")}>{legacy === item.legacy_key ? "选择对应商品" : "关联产品"}</button>
      </>}
    </div>)}
    <div className="shipping-item-picker">
      <input aria-label="搜索产品" placeholder="搜索产品名称或编号" disabled={disabled} value={query}
        onChange={(event) => { setQuery(event.target.value); setSelection(""); }} />
      <select aria-label="选择发货商品" disabled={disabled || !matches.length} value={selection}
        onChange={(event) => setSelection(event.target.value)}>
        <option value="">{matches.length ? "选择发货商品" : "没有匹配的产品"}</option>
        {matches.map((p) => <option key={key(p)} value={key(p)}>{showProject ? p.project_name + " / " : ""}{p.name} · {p.code}</option>)}
      </select>
      <button type="button" className="btn" disabled={disabled || !selection} onClick={add}>
        <Plus size={14} />{legacy ? "关联" : "添加"}
      </button>
    </div>
  </div>;
}

export function canSaveItems(items: ShipmentItem[]) {
  return items.every((item) => item.product_id && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 1000000000);
}

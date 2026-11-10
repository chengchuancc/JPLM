import { useState } from "react";
import { ChevronDown, Link2, Plus, X } from "lucide-react";
import type { ProductChoice, ShipmentItem } from "./shipping-data";

export function itemKey(item: ShipmentItem) {
  return item.project_id + "/" + (item.product_id || item.legacy_key);
}

export function itemPayload(items: ShipmentItem[]) {
  return items.map(({ project_id, product_id, quantity, name, legacy_key }) => product_id
    ? { project_id, product_id, quantity } : { project_id, product_id, quantity, name, legacy_key });
}

export function ShipmentItems({ items, showProject = false, flagEmpty = false }: {
  items: ShipmentItem[]; showProject?: boolean; flagEmpty?: boolean;
}) {
  if (!items.length) return flagEmpty ? <span className="shipping-chip shipping-items-empty">未填商品</span> : <span className="muted">—</span>;
  return <span className="shipping-item-tags">{items.map((item) => {
    const name = (showProject && item.project_name ? item.project_name + " / " : "") + item.name + " × " + item.quantity;
    return <span key={itemKey(item)} className={"shipping-chip" + (!item.product_id || item.available === false ? " unresolved" : "")}
      title={item.code}>{name}{!item.product_id ? "（待关联）" : item.available === false ? "（产品已移除）" : ""}</span>;
  })}</span>;
}

export function ShipmentItemEditor({ products, items, onChange, showProject, disabled, multi, unknownProject }: {
  products: ProductChoice[]; items: ShipmentItem[]; onChange: (items: ShipmentItem[]) => void;
  showProject?: boolean; disabled?: boolean; multi?: boolean;
  unknownProject?: { id: string; name: string };
}) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("");
  const [legacy, setLegacy] = useState("");
  const used = new Set(items.filter((item) => item.product_id).map(itemKey));
  const key = (p: ProductChoice) => p.project_id + "/" + p.id;
  const matches = products.filter((p) => (multi || !used.has(key(p))) && [p.name, p.code, p.english_code, p.project_name]
    .filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  function add(product = matches.find((p) => key(p) === selection)) {
    if (!product) return;
    const replaced = items.find((item) => item.legacy_key === legacy);
    const current = items.find((item) => itemKey(item) === key(product));
    onChange([...items.filter((item) => item !== replaced && item !== current), { product_id: product.id, project_id: product.project_id,
      project_name: product.project_name, name: product.name, code: product.code, available: true,
      quantity: (current?.quantity || 0) + (replaced?.quantity || 1) }]);
    setSelection("");
    setLegacy("");
  }
  function addUnknown() {
    if (!unknownProject || !query.trim()) return;
    onChange([...items, { project_id: unknownProject.id, project_name: unknownProject.name, name: query.trim(),
      product_id: null, legacy_key: "draft:" + Date.now() + ":" + items.length, quantity: 1, available: false }]);
    setQuery("");
  }
  return <div className="shipping-item-editor">
    {items.map((item) => <div key={itemKey(item)} className="shipping-item-edit-row">
      <span><strong>{item.name}</strong>{showProject && item.project_name && <small>{item.project_name}</small>}
        {!item.product_id && multi && <small className="shipping-unmatched-label">待关联</small>}</span>
      {item.product_id || multi ? <>
        <input type="number" aria-label={item.name + "数量"} min={1} max={1000000000} step={1}
          disabled={disabled} value={item.quantity || ""} onChange={(event) => onChange(items.map((line) => line === item ?
            { ...line, quantity: event.target.valueAsNumber || 0 } : line))} />
        <div>
          {!item.product_id && multi && <button type="button" className="shipping-icon-btn" disabled={disabled}
            aria-pressed={legacy === item.legacy_key} aria-label={"关联" + item.name} title="关联产品"
            onClick={() => { setLegacy(item.legacy_key || ""); setQuery(""); }}><Link2 size={14} /></button>}
          <button type="button" className="shipping-icon-btn" disabled={disabled} aria-label={"移除" + item.name}
            onClick={() => onChange(items.filter((line) => line !== item))}><X size={15} /></button>
        </div>
      </> : <>
        <span className="muted">{item.quantity} 件</span>
        <button type="button" className="btn small" disabled={disabled} aria-pressed={legacy === item.legacy_key}
          onClick={() => setLegacy(item.legacy_key || "")}>{legacy === item.legacy_key ? "选择对应商品" : "关联产品"}</button>
      </>}
    </div>)}
    {multi ? <details className="shipping-multi-picker" open={legacy ? true : undefined}>
      <summary className="btn"><ChevronDown size={14} />选择发货商品</summary>
      <div className="shipping-multi-options">
        <input aria-label="搜索产品" placeholder="搜索产品，或填写未关联商品名称" value={query} maxLength={150}
          disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
        <div className="shipping-multi-list">{matches.map((p) => <label key={key(p)}>
          <input type="checkbox" checked={!legacy && used.has(key(p))} disabled={disabled} onChange={(event) => {
            if (event.target.checked) add(p);
            else onChange(items.filter((item) => itemKey(item) !== key(p)));
          }} />
          <span>{showProject ? p.project_name + " / " : ""}{p.name} <small>{p.code}</small></span>
        </label>)}</div>
        {unknownProject && query.trim() && <button type="button" className="btn small" disabled={disabled} onClick={addUnknown}>
          <Plus size={14} />登记未关联商品「{query.trim()}」
        </button>}
      </div>
    </details> : <div className="shipping-item-picker">
      <input aria-label="搜索产品" placeholder="搜索产品名称或编号" disabled={disabled} value={query}
        onChange={(event) => { setQuery(event.target.value); setSelection(""); }} />
      <select aria-label="选择发货商品" disabled={disabled || !matches.length} value={selection}
        onChange={(event) => setSelection(event.target.value)}>
        <option value="">{matches.length ? "选择发货商品" : "没有匹配的产品"}</option>
        {matches.map((p) => <option key={key(p)} value={key(p)}>{showProject ? p.project_name + " / " : ""}{p.name} · {p.code}</option>)}
      </select>
      <button type="button" className="btn" disabled={disabled || !selection} onClick={() => add()}>
        <Plus size={14} />{legacy ? "关联" : "添加"}
      </button>
    </div>}
  </div>;
}

export function canSaveItems(items: ShipmentItem[]) {
  return items.every((item) => (item.product_id || item.name.trim()) &&
    Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 1000000000);
}

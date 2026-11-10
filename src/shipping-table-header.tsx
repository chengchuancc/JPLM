const groupLabels = {
  order: "订单信息",
  goods: "商品信息",
  transport: "运输信息",
  customer: "客户信息",
  notes: "备注",
};

export type ShippingGroup = keyof typeof groupLabels;
type HeaderColumn = { key: string; label: string; group: ShippingGroup; width?: number; fixed?: boolean; hint?: string };

export function ShippingTableHeader({ columns, index, actionWidth }: {
  columns: readonly HeaderColumn[]; index?: boolean; actionWidth?: number;
}) {
  const groups = new Map<ShippingGroup, HeaderColumn[]>();
  for (const column of columns) {
    const group = groups.get(column.group);
    if (group) group.push(column);
    else groups.set(column.group, [column]);
  }
  return <>
    {index && <colgroup><col style={{ width: 45 }} /></colgroup>}
    {[...groups].map(([group, fields]) => <colgroup key={group}>
      {fields.map((column) => <col key={column.key} style={{ width: column.width }} />)}
    </colgroup>)}
    {actionWidth && <colgroup><col style={{ width: actionWidth }} /></colgroup>}
    <thead>
      <tr className="shipping-group-head">
        {index && <th className="shipping-row-index" scope="col" rowSpan={2}>#</th>}
        {[...groups].map(([group, fields]) => <th key={group} scope="colgroup" colSpan={fields.length}
          className={group === "goods" ? "shipping-goods" : undefined}>{groupLabels[group]}</th>)}
        {actionWidth && <th className="shipping-row-action" scope="col" rowSpan={2}>操作</th>}
      </tr>
      <tr className="shipping-field-head">
        {columns.map((column) => <th key={column.key} scope="col" title={column.hint || column.label}
          className={column.fixed ? "shipping-record-key" : column.group === "goods" ? "shipping-goods" : undefined}>
          {column.label}
          {column.hint && <small className="shipping-column-hint">{column.hint}</small>}
        </th>)}
      </tr>
    </thead>
  </>;
}

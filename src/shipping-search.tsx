export type ShippingSearchField = "" | "backer" | "reference";

export function ShippingSearchFieldPicker({ value, onChange, backer = false, reference }: {
  value: ShippingSearchField;
  onChange: (value: ShippingSearchField) => void;
  backer?: boolean;
  reference?: string;
}) {
  return <select className="shipping-search-field" aria-label="搜索字段" value={value}
    onChange={(event) => onChange(event.target.value as ShippingSearchField)}>
    <option value="">综合搜索</option>
    {backer && <option value="backer">Backer 编号</option>}
    {reference && <option value="reference">{reference}</option>}
  </select>;
}

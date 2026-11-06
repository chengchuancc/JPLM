export type Product = {
  english_code: string;
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
};
export type Part = {
  external_code: string;
  brand: string;
  material_serial: number;
  numbering_product_id: string | null;
  id: string;
  code: string;
  name: string;
  category: string;
  spec: string;
  unit: string;
  price: number;
  stock: number;
  min_stock: number;
  location: string;
  material_level: number;
  notes: string;
  created_at: string;
  updated_at: string;
};
export type Supplier = {
  id: string;
  name: string;
  contact: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
};
export type Version = {
  id: string;
  product_id: string;
  name: string;
  notes: string;
  created_at: string;
};
export type BomLine = {
  id: string;
  version_id: string;
  part_id: string;
  qty: number;
  reference: string;
  notes: string;
};
export type Purchase = {
  id: string;
  code: string;
  supplier_id: string;
  date: string;
  notes: string;
  created_at: string;
};
export type PurchaseLine = {
  id: string;
  purchase_id: string;
  part_id: string;
  qty: number;
  price: number;
  received: number;
};
export type Movement = {
  id: string;
  code: string;
  type: string;
  part_id: string;
  qty: number;
  balance: number;
  product_id: string | null;
  purchase_line_id: string | null;
  original_id: string | null;
  reason: string;
  created_at: string;
};
export type FileRecord = {
  id: string;
  owner_type: string;
  owner_id: string;
  name: string;
  original_name?: string;
  mime: string;
  size: number;
  kind: string;
};
export type Quote = {
  id: string;
  part_id: string;
  supplier_id: string;
  price: number | null;
  url: string;
};
export type MaterialLink = {
  reference: string;
  notes: string;
  id: string;
  parent_id: string;
  child_id: string;
  qty: number;
  created_at: string;
};
export type CodeAlias = { code: string; part_id: string };
export type State = {
  material_links: MaterialLink[];
  material_code_aliases: CodeAlias[];
  products: Product[];
  parts: Part[];
  suppliers: Supplier[];
  bom_versions: Version[];
  bom_lines: BomLine[];
  purchases: Purchase[];
  purchase_lines: PurchaseLine[];
  movements: Movement[];
  files: FileRecord[];
  quotes: Quote[];
};
export const emptyState: State = {
  material_links: [],
  material_code_aliases: [],
  products: [],
  parts: [],
  suppliers: [],
  bom_versions: [],
  bom_lines: [],
  purchases: [],
  purchase_lines: [],
  movements: [],
  files: [],
  quotes: [],
};

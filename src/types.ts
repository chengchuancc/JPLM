export type Product = {
  manager_id: string | null;
  english_code: string;
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
};
export type ProductMold = {
  id: string;
  product_id: string;
  name: string;
  code: string;
  supplier_id: string | null;
  cost: number | null;
  moq: number | null;
  amortization_qty: number | null;
  notes: string;
  part_ids: string[];
};
export type Part = {
  project_id: string;
  project_name?: string;
  shared_image_id?: string | null;
  custodian_name?: string | null;
  secondary_cost?: number | null;
  project_assignments?: { id: string; name: string; assigned: boolean; required: boolean }[];
  deleted_at: string | null;
  purge_after?: string | null;
  purge_blockers?: string[];
  custodian_id: string | null;
  external_code: string;
  brand: string;
  material_serial: number;
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
  responsible_id: string | null;
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
  price: number | null;
  received: number;
};
export type Movement = {
  handler_id: string | null;
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
  occurred_at: string;
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
  project_id: string;
  reference: string;
  notes: string;
  id: string;
  parent_id: string;
  child_id: string;
  qty: number;
  created_at: string;
};
export type CodeAlias = { code: string; part_id: string };
export type UserOption = { id: string; name: string };
export type ProjectRole = "lead" | "engineering" | "purchasing" | "warehouse" | "inspection" | "shipping";
export type ProjectAccess = ProjectRole | "legacy";
export type ProjectSummary = {
  id: string;
  code: string;
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  archived_at: string | null;
  cover_version: string | null;
  cover_file_id: string | null;
  pending_purchases: number;
  updated_at: string;
  roles: ProjectAccess[];
};
export type ProjectDetails = Omit<ProjectSummary, "owner_name" | "pending_purchases" | "cover_version" | "cover_file_id"> & {
  members: string[];
  member_roles?: Record<string, ProjectRole[] | null>;
};
export type User = UserOption & {
  email: string;
  role: "admin" | "member";
  phone: string;
  must_change: number;
  has_avatar: number;
  shopify_import: number;
};
export type Activity = {
  id: number;
  project_name?: string | null;
  actor_name: string;
  action: string;
  subject: string;
  detail: string;
  created_at: string;
};
export type State = {
  material_categories: string[];
  users: UserOption[];
  former_users: UserOption[];
  project?: Omit<ProjectDetails, "members">;
  material_links: MaterialLink[];
  material_code_aliases: CodeAlias[];
  products: Product[];
  product_molds: ProductMold[];
  parts: Part[];
  shared_parts: Part[];
  deleted_parts: Part[];
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
  material_categories: ["结构物料", "电子物料"],
  users: [],
  former_users: [],
  material_links: [],
  material_code_aliases: [],
  products: [],
  product_molds: [],
  parts: [],
  shared_parts: [],
  deleted_parts: [],
  suppliers: [],
  bom_versions: [],
  bom_lines: [],
  purchases: [],
  purchase_lines: [],
  movements: [],
  files: [],
  quotes: [],
};

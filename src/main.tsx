import React, { Suspense, lazy, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { clearNavigationSnapshots, NavigationPage, useNavigationHistory, usePageState } from "./navigation";
import {
  Boxes,
  Box,
  Layers,
  Package,
  ShoppingCart,
  Warehouse,
  ArrowLeftRight,
  Truck,
  Search,
  Plus,
  ArrowUpRight,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Grid2X2,
  List,
  ScanLine,
  Settings,
  LogOut,
  X,
  Check,
  Download,
  Upload,
  Trash2,
  Pencil,
  Copy,
  FileText,
  Paperclip,
  Image as ImageIcon,
  QrCode,
  Printer,
  Camera,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  RotateCcw,
  CircleHelp,
  ClipboardCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Loader2,
  Menu,
  Archive,
  Link as LinkIcon,
  SquareArrowOutUpRight,
  FolderOpen,
  Command,
} from "lucide-react";
import QRCode from "qrcode";
import Papa from "papaparse";
import {
  emptyState,
  State,
  Product,
  ProjectSummary,
  ProjectDetails,
  Part,
  Supplier,
  Quote,
  Purchase,
  Movement,
  PurchaseLine,
  BomLine,
  FileRecord,
  User,
  UserOption,
  Activity,
} from "./types";
import {
  MaterialTable,
  ColumnVisibility,
  type Column,
} from "./material-table";
import { MaterialCategory, TableOptionPicker } from "./material-category";
import { materialCategoryTone, OptionTag, type OptionTone } from "./option-tag";
import "./style.css";
import { ProductionInspection } from "./inspection";
import { Dialog } from "./dialog";
import type { LabelMaterial } from "./material-labels";

const ShippingManagement = lazy(() => import("./shipping"));
const GlobalShipping = lazy(() => import("./global-shipping"));
const MaterialLabelsDialog = lazy(() => import("./material-labels"));
const money = (n: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
const amount = (n: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(n);
const date = (s: string) =>
  new Date(s).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
const datetime = (s: string) =>
  new Date(s).toLocaleString("zh-CN", { hour12: false });
const recentMovements = (rows: Movement[]) => rows.slice().reverse()
  .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
const localDateTime = (value?: string) => {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const appBase = new URL(".", document.baseURI).pathname;
const fileUrl = (id: string) => appBase + "files/" + encodeURIComponent(id);
async function api(path: string, method = "GET", data?: unknown) {
  const r = await fetch(appBase + "api/" + path, {
    method,
    headers:
      data instanceof FormData ? {} : {
        "Content-Type": data instanceof Blob ? data.type : "application/json",
      },
    body: data
      ? data instanceof FormData || data instanceof Blob
        ? data
        : JSON.stringify(data)
      : undefined,
  });
  const j = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("auth/"))
      window.dispatchEvent(new Event("plm-session-expired"));
    throw Error(j.error || "请求失败");
  }
  return j;
}
const ProjectContext = React.createContext({ id: "", archived: false });
function projectRequest(projectId: string, path: string, method = "GET", data?: unknown) {
  return api("projects/" + encodeURIComponent(projectId) + "/" + path, method, data);
}

function uploadProjectFiles(projectId: string, owner: string, id: string, files: File[], replace?: string) {
  const manifest = {
    owner_type: owner,
    owner_id: id,
    replace_id: replace,
    files: files.map((file) => ({ name: file.name, size: file.size })),
  };
  const batch = new Blob([JSON.stringify(manifest) + "\n", ...files], {
    type: "application/vnd.jplm.file-batch",
  });
  return projectRequest(projectId, "files", "POST", batch);
}

function download(content: Blob | string, name: string) {
  const url = URL.createObjectURL(
    content instanceof Blob
      ? content
      : new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCSV(rows: Record<string, unknown>[], name: string) {
  download(Papa.unparse(rows, { escapeFormulae: true }), name + ".csv");
}
const navs = [
  { id: "products", name: "产品管理", icon: Boxes },
  { id: "parts", name: "物料库", icon: Package },
  { id: "suppliers", name: "供应商", icon: Truck },
  { id: "purchases", name: "采购管理", icon: ShoppingCart },
  { id: "inventory", name: "库存查询", icon: Warehouse },
  { id: "movements", name: "库存流水", icon: ArrowLeftRight },
  { id: "inspection", name: "生产检测", icon: ClipboardCheck },
  { id: "shipping", name: "发货管理", icon: Truck },
];
type Modal = { kind: string; item?: any; extra?: any } | null;
type Field = {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  categoryOptions?: string[];
  placeholder?: string;
  wide?: boolean;
  min?: number;
  step?: string;
  create?: CreateChoice;
  optionFilter?: (value: string) => boolean;
};
type CreateChoice = {
  resource: "parts" | "products" | "suppliers";
  level?: number;
};
type ChoiceRequest = CreateChoice & {
  select: (id: string, updated: State) => void;
};
type SupplierOption = { value: string; label: string };
type SupplierDraft = { ids: string[]; names: string[]; pending: string };

function supplierChanges(draft: SupplierDraft, original: string[] = []) {
  const add = draft.ids.filter((id) => !original.includes(id));
  const remove = original.filter((id) => !draft.ids.includes(id));
  const create = Array.from(new Set([...draft.names, draft.pending.trim()].filter(Boolean)));
  return add.length || remove.length || create.length ? { add, remove, create } : undefined;
}

function SupplierLinksInput({ options, draft, onChange, disabled }: {
  options: SupplierOption[];
  draft: SupplierDraft;
  onChange: React.Dispatch<React.SetStateAction<SupplierDraft>>;
  disabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const addName = () => {
    onChange((previous) => {
      const name = previous.pending.trim();
      return name ? { ...previous, names: Array.from(new Set([...previous.names, name])), pending: "" } : previous;
    });
    setAdding(false);
  };
  return (
    <div className="supplier-links-input wide-field">
      <label className="form-label">
        供应商
        <select aria-label="选择供应商" value="" disabled={disabled} onChange={(event) => {
          const id = event.target.value;
          if (id) onChange((previous) => ({ ...previous, ids: [...previous.ids, id] }));
        }}>
          <option value="">选择已有供应商</option>
          {options.filter((item) => !draft.ids.includes(item.value)).map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <Button small type="button" disabled={disabled || adding} onClick={() => setAdding(true)}>
        <Plus size={14} />新建供应商
      </Button>
      {adding && <div className="supplier-name-input">
        <input aria-label="新供应商名称" placeholder="输入供应商名称" autoFocus maxLength={1000} value={draft.pending}
          disabled={disabled} onChange={(event) => {
            const pending = event.target.value;
            onChange((previous) => ({ ...previous, pending }));
          }} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.pending.trim()) addName();
            }
          }} />
        <Button small type="button" disabled={disabled || !draft.pending.trim()} onClick={addName}>加入</Button>
        <Button small type="button" disabled={disabled} onClick={() => {
          onChange((previous) => ({ ...previous, pending: "" }));
          setAdding(false);
        }}>取消新建</Button>
      </div>}
      <div className="selected-records">
        {draft.ids.map((id) => {
          const label = options.find((item) => item.value === id)?.label || "供应商";
          return <span className="record-tag" key={id}><span title={label}>{label}</span>
            <button type="button" disabled={disabled} aria-label={"移除关联 " + label}
              onClick={() => onChange((previous) => ({ ...previous, ids: previous.ids.filter((item) => item !== id) }))}>
              <X size={12} />
            </button>
          </span>;
        })}
        {draft.names.map((name) => <span className="record-tag" key={"new:" + name}><span title={name}>{name}</span><small>待新建</small>
          <button type="button" disabled={disabled} aria-label={"取消新建 " + name}
            onClick={() => onChange((previous) => ({ ...previous, names: previous.names.filter((item) => item !== name) }))}>
            <X size={12} />
          </button>
        </span>)}
      </div>
    </div>
  );
}

const ChoiceContext = React.createContext<
  ((request: ChoiceRequest) => void) | null
>(null);
const choiceNames = { parts: "物料", products: "产品", suppliers: "供应商" };

function ChoiceSelect({
  create,
  onValueChange,
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
  create?: CreateChoice;
  onValueChange: (id: string, updated?: State) => void;
}) {
  const open = useContext(ChoiceContext);
  return (
    <select
      {...props}
      onChange={(e) => {
        if (e.target.value === "__create_record__" && open && create) {
          const select = e.currentTarget;
          select.value = String(props.value ?? "");
          open({ ...create, select: onValueChange });
        } else {
          onValueChange(e.target.value);
        }
      }}
    >
      {children}
      {open && create && (
        <option value="__create_record__">
          ＋ 新建{choiceNames[create.resource]}
        </option>
      )}
    </select>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  small = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <button
      {...props}
      className={`btn ${primary ? "primary" : ""} ${small ? "small" : ""} ${props.className || ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Empty({
  title = "暂无记录",
  text = "",
  action,
}: {
  title?: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FolderOpen size={28} />
      </div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
type BomLinkOptions = {
  products: Product[];
  versions: State["bom_versions"];
  linked: BomLine[];
};

function BomLinksInput({
  products,
  versions,
  selected,
  onChange,
  disabled,
}: Omit<BomLinkOptions, "linked"> & {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="wide-field bom-links-input">
      <label className="form-label">
        关联 BOM
        <select
          aria-label="关联 BOM"
          value=""
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value) onChange([...selected, event.target.value]);
          }}
        >
          <option value="" disabled>选择产品和版本（默认用量 1）</option>
          {products.map((product) => (
            <optgroup key={product.id} label={product.name}>
              {versions.filter((version) => version.product_id === product.id).reverse().map((version) => (
                <option key={version.id} value={version.id} disabled={selected.includes(version.id)}>
                  {product.name} · {version.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {selected.length > 0 && (
        <div className="selected-records">
          {selected.map((id) => {
            const version = versions.find((item) => item.id === id);
            if (!version) return null;
            const name = products.find((product) => product.id === version.product_id)?.name;
            const label = `${name} · ${version.name}`;
            return (
              <span className="record-tag" key={id}>
                {label}
                <button type="button" disabled={disabled} aria-label={"取消关联 " + label}
                  onClick={() => onChange(selected.filter((item) => item !== id))}>
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EntityForm({
  fields,
  initial = {},
  submit,
  onCancel,
  label = "保存",
  images,
  suppliers,
  bomLinks,
}: {
  fields: Field[];
  initial?: any;
  submit: (d: any) => Promise<void>;
  onCancel?: () => void;
  label?: string;
  images?: {
    upload: (files: File[]) => Promise<void>;
    finish: () => Promise<void>;
  };
  suppliers?: { options: SupplierOption[]; linked: string[] };
  bomLinks?: BomLinkOptions;
}) {
  const [values, setValues] = useState<any>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<File[]>([]);
  const originalBomLines = useRef(bomLinks?.linked || []);
  const [bomIds, setBomIds] = useState(() => originalBomLines.current.map((line) => line.version_id));
  const originalSuppliers = useRef(suppliers?.linked || []);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>({
    ids: originalSuppliers.current, names: [], pending: "",
  });
  function addImages(files: File[]) {
    if (!files.length) return;
    setSelected((current) => [...current, ...files]);
    setError("");
  }
  return (
    <form
      onPaste={(event) => {
        if (!images || busy) return;
        const files = pasteEventImages(event);
        if (!files.length) return;
        event.preventDefault();
        addImages(files);
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          const payload = { ...values };
          if (suppliers) payload.supplier_changes = supplierChanges(supplierDraft, originalSuppliers.current);
          if (bomLinks) {
            const add = bomIds.filter((id) => !originalBomLines.current.some((line) => line.version_id === id));
            const remove = originalBomLines.current.filter((line) => !bomIds.includes(line.version_id)).map((line) => line.id);
            if (add.length || remove.length) payload.bom_changes = { add, remove };
          }
          await submit(payload);
          if (images) {
            if (selected.length) {
              await images.upload(selected);
              setSelected([]);
            }
            await images.finish();
          }
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {images && (
        <ImagePasteArea
          selected={selected}
          busy={busy}
          addImages={addImages}
          setError={setError}
          removeImage={(index) =>
            setSelected((files) => files.filter((_, i) => i !== index))
          }
        />
      )}
      <div className="form-grid">
        {fields.map((f) => (
          <React.Fragment key={f.name}>
            <label className={f.wide ? "wide-field" : ""}>
              {f.label}
              {f.required && <span className="required"> *</span>}
              {f.categoryOptions ? <MaterialCategory label={f.label} value={values[f.name] ?? ""}
                options={f.categoryOptions} disabled={busy} onChange={(value) =>
                  setValues((previous: any) => ({ ...previous, [f.name]: value }))} /> : f.type === "textarea" ? (
                <textarea
                  rows={3}
                  value={values[f.name] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f.name]: e.target.value })
                  }
                />
              ) : f.options ? (
                <ChoiceSelect
                  create={f.create}
                  required={f.required}
                  value={values[f.name] ?? ""}
                  onValueChange={(value) =>
                    setValues((previous: any) => ({
                      ...previous,
                      [f.name]: value,
                    }))
                  }
                >
                  <option value="">请选择</option>
                  {f.options
                    .filter(
                      (o) =>
                        o.value === values[f.name] ||
                        !f.optionFilter ||
                        f.optionFilter(o.value),
                    )
                    .map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                </ChoiceSelect>
              ) : (
                <input
                  required={f.required}
                  type={f.type || "text"}
                  autoComplete={f.autoComplete}
                  min={f.min ?? (f.type === "number" ? 0 : undefined)}
                  step={f.step || (f.type === "number" ? "any" : undefined)}
                  placeholder={f.placeholder}
                  value={values[f.name] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f.name]: e.target.value })
                  }
                />
              )}
            </label>
            {f.name === "name" && suppliers && <SupplierLinksInput options={suppliers.options}
              draft={supplierDraft} onChange={setSupplierDraft} disabled={busy} />}
            {f.name === "name" && bomLinks && <BomLinksInput products={bomLinks.products}
              versions={bomLinks.versions} selected={bomIds} onChange={setBomIds} disabled={busy} />}
          </React.Fragment>
        ))}
      </div>
      {error && (
        <div className="form-error">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      <div className="dialog-actions">
        {onCancel && (
          <Button type="button" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button primary disabled={busy} type="submit">
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{" "}
          {label}
        </Button>
      </div>
    </form>
  );
}
function LoginBrand() {
  return (
    <div className="login-brand">
      <img
        className="brand-wordmark"
        src={appBase + "brand-wordmark-black.png"}
        alt="MakaGiC"
        width={1134}
        height={188}
      />
      <strong>捷程未来PLM</strong>
    </div>
  );
}

function BrandMark() {
  return <img className="brand-mark" src={appBase + "brand-mark.png"} alt="" />;
}

function Login({
  initialized,
  onLogin,
  restored = false,
}: {
  initialized: boolean;
  onLogin: () => void;
  restored?: boolean;
}) {
  return (
    <div className="login-page compact-login">
      <div className="login-card">
        <LoginBrand />
        <h2>{initialized ? "登录" : "创建管理员"}</h2>
        {restored && <p className="muted">已恢复数据，请重新登录。</p>}
        <EntityForm
          fields={[
            ...(!initialized
              ? [{ name: "name", label: "用户名", required: true, wide: true }]
              : []),
            {
              name: "email",
              label: "邮箱",
              type: "email",
              required: true,
              wide: true,
            },
            {
              name: "password",
              label: "密码",
              type: "password",
              required: true,
              wide: true,
              placeholder: "输入密码",
            },
          ]}
          submit={async (d) => {
            await api("auth/" + (initialized ? "login" : "setup"), "POST", d);
            onLogin();
          }}
          label={initialized ? "登录" : "保存"}
        />
      </div>
    </div>
  );
}
function Avatar({
  user,
  version,
  small = false,
}: {
  user?: User | null;
  version: number;
  small?: boolean;
}) {
  return (
    <span className={"user-avatar" + (small ? " small-avatar" : "")}>
      {user?.has_avatar ? (
        <img
          src={appBase + "api/avatars/" + user.id + "?v=" + version}
          alt=""
        />
      ) : (
        user?.name.slice(0, 1) || "人"
      )}
    </span>
  );
}

function PersonSelect({
  users,
  label,
  value,
  onChange,
}: {
  users: UserOption[];
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label} *
      <select
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function PasswordForm({ onSaved }: { onSaved: () => Promise<void> }) {
  return (
    <EntityForm
      fields={[
        {
          name: "current_password",
          label: "当前密码",
          type: "password",
          required: true,
          wide: true,
        },
        {
          name: "password",
          label: "新密码",
          type: "password",
          required: true,
          wide: true,
        },
        {
          name: "confirm",
          label: "确认新密码",
          type: "password",
          required: true,
          wide: true,
        },
      ]}
      submit={async (data) => {
        if (data.password !== data.confirm) throw Error("两次输入的密码不一致");
        await api("account/password", "POST", {
          current_password: data.current_password,
          password: data.password,
        });
        await onSaved();
      }}
    />
  );
}

function ProfilePanel({
  user,
  version,
  onSaved,
}: {
  user: User;
  version: number;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-heading">
          <h3>个人资料</h3>
        </div>
        <div className="profile-identity">
          <Avatar user={user} version={version} />
          <div>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <label className="btn small">
            更换头像
            <input
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              disabled={uploading}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setError("");
                setUploading(true);
                try {
                  const form = new FormData();
                  form.append("file", file);
                  await api("account/avatar", "POST", form);
                  await onSaved();
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <EntityForm
          initial={{ phone: user.phone }}
          fields={[{ name: "phone", label: "手机号", type: "tel", wide: true }]}
          submit={async (data) => {
            await api("account/profile", "PUT", data);
            await onSaved();
          }}
        />
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h3>修改密码</h3>
        </div>
        <PasswordForm key={version} onSaved={onSaved} />
      </section>
    </div>
  );
}

function UserAdmin({
  actorId,
  onChange,
}: {
  actorId: string;
  onChange: () => Promise<unknown>;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [editor, setEditor] = useState<{ user?: User; reset?: boolean } | null>(
    null,
  );
  const [error, setError] = useState("");
  async function loadUsers() {
    try {
      setUsers(await api("users"));
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  useEffect(() => {
    void loadUsers();
  }, []);
  return (
    <>
      <div className="section-toolbar">
        <h3>用户管理</h3>
        <Button small primary onClick={() => setEditor({})}>
          <Plus size={15} />
          新增用户
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>邮箱</th>
              <th>手机号</th>
              <th>权限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.phone || "—"}</td>
                <td>{user.role === "admin" ? "管理员" : "成员"}</td>
                <td>
                  <div className="row-actions">
                    <Button small onClick={() => setEditor({ user })}>
                      编辑
                    </Button>
                    {user.id !== actorId && (
                      <Button
                        small
                        onClick={() => setEditor({ user, reset: true })}
                      >
                        重置密码
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editor && (
        <Dialog
          title={
            editor.reset
              ? "重置密码 · " + editor.user?.name
              : editor.user
                ? "编辑用户"
                : "新增用户"
          }
          onClose={() => setEditor(null)}
        >
          <EntityForm
            initial={
              editor.user
                ? { name: editor.user.name, email: editor.user.email }
                : {}
            }
            fields={[
              ...(!editor.reset
                ? [
                    {
                      name: "name",
                      label: "用户名",
                      required: true,
                      wide: true,
                    },
                    {
                      name: "email",
                      label: "邮箱",
                      type: "email",
                      required: true,
                      wide: true,
                    },
                  ]
                : []),
              ...(!editor.user || editor.reset
                ? [
                    {
                      name: "password",
                      label: "临时密码",
                      type: "password",
                      required: true,
                      wide: true,
                    },
                  ]
                : []),
            ]}
            onCancel={() => setEditor(null)}
            submit={async (data) => {
              if (editor.reset)
                await api("reset-password/" + editor.user!.id, "POST", {
                  password: data.password,
                });
              else if (editor.user)
                await api("users/" + editor.user.id, "PUT", data);
              else await api("users", "POST", data);
              setEditor(null);
              await Promise.all([loadUsers(), onChange()]);
            }}
          />
        </Dialog>
      )}
    </>
  );
}

function ActivityPanel({
  part,
  kind = "operation",
}: {
  part?: string;
  kind?: "operation" | "login";
}) {
  const { id: projectId } = useContext(ProjectContext);
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function loadActivity(before = 0) {
    setBusy(true);
    setError("");
    try {
      const path = "activity?" + new URLSearchParams({ before: String(before), part: part || "", kind });
      const result = projectId && kind === "operation"
        ? await projectRequest(projectId, path)
        : await api(path);
      setItems((previous) =>
        before ? [...previous, ...result.items] : result.items,
      );
      setMore(result.more);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void loadActivity();
  }, [part, kind]);
  return (
    <>
      <div className="section-toolbar">
        <h3>{kind === "login" ? "登录记录" : "操作记录"}</h3>
        <Button small disabled={busy} onClick={() => loadActivity()}>
          <RefreshCw size={14} />
          刷新
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>操作</th>
              {kind !== "login" && (
                <>
                  <th>记录</th>
                  <th>详情</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="nowrap">{datetime(item.created_at)}</td>
                <td>{item.actor_name}</td>
                <td>{item.action}</td>
                {kind !== "login" && (
                  <>
                    <td>{item.subject}</td>
                    <td>{item.detail || "—"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && !items.length && (
          <Empty title={kind === "login" ? "暂无登录记录" : "暂无操作记录"} />
        )}
      </div>
      {more && (
        <Button
          small
          disabled={busy}
          onClick={() => loadActivity(items.at(-1)?.id)}
        >
          加载更多
        </Button>
      )}
    </>
  );
}

function BackupPanel({ onRestored }: { onRestored: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>备份与恢复</h3>
        <Download size={18} />
      </div>
      <a className="btn primary" href={appBase + "api/backup"} download>
        <Download size={15} />
        下载 ZIP 备份
      </a>
      <form
        className="backup-restore-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!file || !confirmed || busy) return;
          setBusy(true);
          setError("");
          try {
            const response = await fetch(appBase + "api/restore", {
              method: "POST",
              headers: {
                "Content-Type": "application/zip",
                "X-PLM-Restore": "replace",
              },
              body: file,
            });
            if (!response.ok) {
              const result = await response.json().catch(() => ({}));
              throw Error(result.error || "恢复失败");
            }
            onRestored();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="form-label">
          恢复 ZIP 备份
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            required
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setConfirmed(false);
              setError("");
            }}
          />
        </label>
        {file && (
          <label className="restore-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              required
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            用备份覆盖当前数据，恢复后重新登录
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!file || !confirmed || busy}>
          {busy ? "正在恢复…" : "恢复备份"}
        </Button>
      </form>
    </section>
  );
}
type LibraryAsset = {
  source: "file" | "cover" | "avatar";
  id: string;
  name: string;
  kind: "image" | "attachment";
  size: number;
  project: string;
  owner: string;
  reference_count: number;
  fallback_cover: number;
};
type AssetPage = { items: LibraryAsset[]; more: boolean };

function assetUrl(asset: LibraryAsset) {
  return appBase + "api/assets/" + asset.source + "/" + encodeURIComponent(asset.id);
}

function assetSize(bytes: number) {
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function AssetLibrary() {
  const [draft, setDraft] = usePageState("assets.draft", "");
  const [search, setSearch] = usePageState("assets.search", "");
  const [kind, setKind] = usePageState("assets.kind", "");
  const [page, setPage] = usePageState("assets.page", 1);
  const [data, setData] = useState<AssetPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<LibraryAsset | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ q: search, kind, page: String(page) });
    api("assets?" + query).then((result: AssetPage) => {
      if (active) setData(result);
    }, (failure: Error) => {
      if (active) {
        setData(null);
        setError(failure.message);
      }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [search, kind, page]);

  return <section className="asset-library">
    <form className="toolbar-controls asset-library-toolbar" onSubmit={(event) => {
      event.preventDefault();
      setSearch(draft.trim());
      setPage(1);
    }}>
      <input type="search" aria-label="搜索素材" placeholder="搜索文件名、项目或引用对象"
        value={draft} onChange={(event) => setDraft(event.target.value)} />
      <select aria-label="素材类型" value={kind} onChange={(event) => {
        setKind(event.target.value);
        setPage(1);
      }}>
        <option value="">全部类型</option>
        <option value="image">图片</option>
        <option value="attachment">附件</option>
      </select>
      <Button type="submit" small><Search size={15} />搜索</Button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="table-wrap" aria-busy={busy}>
      <table>
        <thead><tr>
          <th>文件</th><th>类型</th><th className="num">大小</th>
          <th className="num">引用次数</th><th>引用对象</th><th>操作</th>
        </tr></thead>
        <tbody>{data?.items.map((asset) => (
          <tr key={asset.source + "/" + asset.id}>
            <td><div className="asset-library-file">
              {asset.kind === "image"
                ? <button type="button" className="asset-library-thumbnail" aria-label={"预览 " + asset.name}
                    onClick={() => setPreview(asset)}>
                    <img src={assetUrl(asset)} alt="" loading="lazy" />
                  </button>
                : <FileText size={18} />}
              <span title={asset.name}>{asset.name}</span>
            </div></td>
            <td>{asset.kind === "image" ? "图片" : "附件"}</td>
            <td className="num" title={asset.size + " B"}>{assetSize(asset.size)}</td>
            <td className="num"><strong>{asset.reference_count}</strong></td>
            <td>
              {asset.owner || "—"}{asset.fallback_cover ? "、项目封面" : ""}
              {asset.project && <small>{asset.project}</small>}
            </td>
            <td><a className="text-link" href={assetUrl(asset)} download={asset.name}>下载</a></td>
          </tr>
        ))}</tbody>
      </table>
      {!data?.items.length && !error && <p className="asset-library-empty muted">
        {busy ? "正在加载…" : "暂无素材"}
      </p>}
    </div>
    {(page > 1 || data?.more) && <div className="dialog-actions">
      <Button type="button" small disabled={busy || page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
      <span>第 {page} 页</span>
      <Button type="button" small disabled={busy || !data?.more} onClick={() => setPage(page + 1)}>下一页</Button>
    </div>}
    {preview && <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
      <div className="image-preview"><img src={assetUrl(preview)} alt={preview.name} /></div>
    </Dialog>}
  </section>;
}

type AuthState = {
  initialized: boolean;
  authenticated: boolean;
  user: User | null;
};
type WorkspaceRoute = { projectId: string; view: string; detail: string };
const projectHome: WorkspaceRoute = { projectId: "", view: "projects", detail: "" };

function readWorkspaceRoute(hash = location.hash): WorkspaceRoute {
  const [top, id, view, detail] = hash.slice(1).split("/");
  if (top === "settings") return { ...projectHome, view: "settings" };
  if (top === "global-shipping") return { ...projectHome, view: "global-shipping", detail: /^[a-f0-9]{24}$/.test(id || "") ? id : "" };
  if (top === "projects" && id) {
    const valid = navs.some((nav) => nav.id === view) || view === "project-settings";
    return { projectId: id, view: valid ? view : "products", detail: valid ? detail || "" : "" };
  }
  if (id && ["products", "parts", "purchases", "suppliers"].includes(top))
    return { projectId: "", view: top, detail: id };
  return projectHome;
}

function workspaceHash(route: WorkspaceRoute) {
  const base = route.projectId ? "projects/" + route.projectId + "/" : "";
  return "#" + base + route.view + (route.detail ? "/" + route.detail : "");
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [restored, setRestored] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const draftOpen = useRef(false);
  const { route, entry, navigate, back } = useNavigationHistory({
    readRoute: readWorkspaceRoute,
    routeHash: workspaceHash,
    canLeave: (current, next) => !draftOpen.current || (
      current.projectId === next.projectId &&
      (!["inspection", "shipping", "global-shipping"].includes(current.view) || (current.view === next.view && current.detail === next.detail))
    ) || window.confirm("有未保存的内容。离开当前页面？"),
  });

  const reloadProjects = async () => {
    const next: ProjectSummary[] = await api("projects");
    setProjects(next);
    return next;
  };
  async function load() {
    setLoading(true);
    setError("");
    try {
      const status: AuthState = await api("auth/status");
      setAuth(status);
      if (status.authenticated && !status.user?.must_change) await reloadProjects();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const expire = () => {
      draftOpen.current = false;
      clearNavigationSnapshots();
      setProjects([]);
      setAuth((a) => a && { ...a, authenticated: false, user: null });
    };
    window.addEventListener("plm-session-expired", expire);
    return () => {
      window.removeEventListener("plm-session-expired", expire);
    };
  }, []);
  useEffect(() => {
    if (route.projectId || route.view === "global-shipping" || !route.detail || !auth?.authenticated || auth.user?.must_change) return;
    let active = true;
    api("resolve/" + route.view + "/" + encodeURIComponent(route.detail)).then(
      (record) => { if (active) navigate({ ...route, projectId: record.project_id }, true); },
      () => { if (active) navigate(projectHome, true); },
    );
    return () => { active = false; };
  }, [route, auth?.authenticated, auth?.user?.must_change]);

  if (loading) return <div className="loading-page"><BrandMark /><span>加载中…</span></div>;
  if (error) return <div className="loading-page"><AlertCircle /><p>{error}</p><Button onClick={load}>重试</Button></div>;
  if (!auth?.authenticated || !auth.user)
    return <Login initialized={auth?.initialized || false} onLogin={load} restored={restored} />;
  if (auth.user.must_change)
    return (
      <div className="login-page compact-login">
        <div className="login-card">
          <LoginBrand />
          <h2>修改初始密码</h2>
          <PasswordForm onSaved={load} />
          <Button onClick={async () => { await api("auth/logout", "POST"); await load(); }}>退出登录</Button>
        </div>
      </div>
    );
  if (!route.projectId && route.detail && route.view !== "global-shipping")
    return <div className="loading-page"><BrandMark /><span>正在打开记录…</span></div>;
  const project = projects.find((item) => item.id === route.projectId);
  if (route.projectId && !project)
    return (
      <div className="loading-page">
        <BrandMark /><span>项目不存在或无权访问</span>
        <Button onClick={() => back(projectHome)}>返回上一页</Button>
      </div>
    );
  return (
    <NavigationPage key={entry.id} id={entry.id}>
      <Workspace
        route={route}
        project={project}
        projects={projects}
        currentUser={auth.user}
        navigate={navigate}
        back={back}
        canGoBack={!!entry.previous}
        draftOpen={draftOpen}
        reloadProjects={reloadProjects}
        updateUser={async () => setAuth(await api("auth/status"))}
        onLogout={async () => {
          await api("auth/logout", "POST");
          draftOpen.current = false;
          navigate(projectHome, true);
          clearNavigationSnapshots();
          setProjects([]);
          setAuth({ ...auth, authenticated: false, user: null });
        }}
        onRestore={() => {
          draftOpen.current = false;
          navigate(projectHome, true);
          clearNavigationSnapshots();
          setProjects([]);
          setRestored(true);
          setAuth({ initialized: true, authenticated: false, user: null });
        }}
      />
    </NavigationPage>
  );
}

function ProjectCover({ project }: { project: ProjectSummary }) {
  const [failed, setFailed] = useState("");
  const source = project.cover_version
    ? appBase + "api/projects/" + encodeURIComponent(project.id) + "/cover?v=" + encodeURIComponent(project.cover_version)
    : project.cover_file_id ? fileUrl(project.cover_file_id) : "";
  const hasPhoto = !!source && failed !== source;
  return (
    <div className={"project-cover" + (hasPhoto ? " has-photo" : "")}>
      {hasPhoto ? (
        <img key={source} src={source} alt={project.name + " 封面"} loading="lazy" onError={() => setFailed(source)} />
      ) : (
        <img src={appBase + "project-drawing.svg"} alt="" aria-hidden="true" />
      )}
    </div>
  );
}

type DeletedProject = Pick<ProjectSummary, "id" | "code" | "name"> & { deleted_at: string };

function ProjectDirectory({ projects, open, create, onRecovered }: {
  projects: ProjectSummary[];
  open: (id: string) => void;
  create?: (name: string) => Promise<void>;
  onRecovered: () => Promise<unknown>;
}) {
  const [query, setQuery] = usePageState("projects.query", "");
  const [status, setStatus] = usePageState<"active" | "archived" | "deleted">("projects.status", "active");
  const [creating, setCreating] = useState(false);
  const [deleted, setDeleted] = useState<DeletedProject[] | null>(null);
  const [deletedError, setDeletedError] = useState("");
  const [recovering, setRecovering] = useState<DeletedProject | null>(null);
  useEffect(() => {
    if (status !== "deleted" || !create) return;
    let active = true;
    setDeleted(null);
    setDeletedError("");
    api("projects?deleted=1").then(
      (rows) => { if (active) setDeleted(rows); },
      (error) => { if (active) setDeletedError(error.message); },
    );
    return () => { active = false; };
  }, [status, !!create]);
  const term = query.trim().toLowerCase();
  const matches = (project: Pick<ProjectSummary, "name" | "code">) =>
    [project.name, project.code].some((value) => value.toLowerCase().includes(term));
  const archived = status === "archived";
  const rows = projects.filter((project) => !!project.archived_at === archived && matches(project));
  const deletedRows = deleted?.filter(matches);
  const activeCount = projects.filter((project) => !project.archived_at).length;
  return (
    <section className="project-directory">
      <header className="project-directory-hero">
        <img className="project-hero-art" src={appBase + "project-drawing.svg"} alt="" />
        <div className="project-hero-content">
          <p className="project-hero-eyebrow">捷程未来 PLM</p>
          <h1>项目工作台</h1>
          <div className="project-hero-summary">
            <span><strong>{activeCount}</strong> 进行中</span>
            <span><strong>{projects.length - activeCount}</strong> 已归档</span>
          </div>
        </div>
        {create && (
          <Button primary className="project-create" onClick={() => setCreating(true)}>
            <Plus size={17} />新建项目
          </Button>
        )}
      </header>

      <div className="section-toolbar project-directory-toolbar">
        <div className="tabs" aria-label="项目状态">
          <button className={status === "active" ? "selected" : ""} aria-pressed={status === "active"}
            onClick={() => setStatus("active")}>进行中</button>
          <button className={archived ? "selected" : ""} aria-pressed={archived}
            onClick={() => setStatus("archived")}>已归档</button>
          {create && <button className={status === "deleted" ? "selected" : ""} aria-pressed={status === "deleted"}
            onClick={() => setStatus("deleted")}>已删除</button>}
        </div>
        <div className="search-input">
          <Search size={15} />
          <input aria-label="搜索项目" placeholder="搜索项目名称、代号…" type="search" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      {status === "deleted" ? (
        <div className="table-wrap">
          {deletedError ? <p className="form-error" role="alert">{deletedError}</p> :
            !deletedRows ? <p className="project-deleted-loading muted" role="status">加载中…</p> :
            deletedRows.length ? (
              <table>
                <thead><tr><th>项目</th><th>删除时间</th><th>操作</th></tr></thead>
                <tbody>{deletedRows.map((project) => (
                  <tr key={project.id}>
                    <td>{project.name}<small className="mono">{project.code}</small></td>
                    <td>{datetime(project.deleted_at)}</td>
                    <td><Button small onClick={() => setRecovering(project)}>撤销删除</Button></td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty title={term ? "没有符合条件的项目" : "暂无已删除项目"} />}
        </div>
      ) : rows.length ? (
        <ul className="project-card-grid" aria-label="项目">
          {rows.map((project) => (
            <li key={project.id}>
              <a className="project-card" href={workspaceHash({ projectId: project.id, view: "products", detail: "" })}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  open(project.id);
                }}>
                <div className="project-card-media">
                  <ProjectCover project={project} />
                  <span className="project-card-code">{project.code}</span>
                </div>
                <div className="project-card-body">
                  <div className="project-card-title">
                    <h2>{project.name}</h2>
                    <ArrowUpRight size={20} aria-hidden="true" />
                  </div>
                  <div className="project-card-meta">
                    <span title={project.owner_name || "未指定负责人"}>{project.owner_name || "未指定负责人"}</span>
                    <span>待入库 <b>{project.pending_purchases}</b> 单</span>
                  </div>
                  <time dateTime={project.updated_at}>更新于 {date(project.updated_at)}</time>
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <div className="project-directory-empty">
          <Empty title={term ? "没有符合条件的项目" : archived ? "暂无归档项目" : "暂无项目"}
            action={term ? <Button small onClick={() => setQuery("")}>清除搜索</Button> : undefined} />
        </div>
      )}
      {recovering && (
        <Dialog title="撤销删除项目" onClose={() => setRecovering(null)}>
          <p className="confirm-copy">「{recovering.name}」将回到「已归档」。</p>
          <AsyncAction label="撤销删除" onCancel={() => setRecovering(null)} action={async () => {
            await projectRequest(recovering.id, "recover", "POST");
            setDeleted((previous) => previous?.filter((project) => project.id !== recovering.id) ?? []);
            setRecovering(null);
            await onRecovered();
          }} />
        </Dialog>
      )}
      {creating && create && (
        <Dialog title="新建项目" onClose={() => setCreating(false)}>
          <EntityForm fields={[{ name: "name", label: "项目名称", required: true, wide: true }]}
            label="创建项目" onCancel={() => setCreating(false)}
            submit={async ({ name }) => { await create(name); setCreating(false); }} />
        </Dialog>
      )}
    </section>
  );
}

function ProjectCoverSettings({ project, editable, onSaved }: {
  project: ProjectSummary;
  editable: boolean;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function change(file?: File) {
    if (!editable || busy) return;
    setError("");
    setBusy(true);
    try {
      const form = file ? new FormData() : undefined;
      if (file) form?.append("file", file);
      await projectRequest(project.id, "cover", file ? "POST" : "DELETE", form);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="project-cover-settings" onPaste={(event) => {
      if (!editable || busy) return;
      const [file] = pasteEventImages(event);
      if (!file) return;
      event.preventDefault();
      void change(file);
    }}>
      <ProjectCover project={project} />
      <div>
        <h3>项目封面</h3>
        {editable && <>
          <p className="muted">JPG、PNG、WebP</p>
          <div className="project-cover-actions">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp"
              aria-label="选择项目封面文件" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void change(file);
              }} />
            <Button type="button" small disabled={busy} onClick={() => input.current?.click()}>
              <ImageIcon size={15} />{project.cover_version ? "更换封面" : "上传封面"}
            </Button>
            <Button type="button" small disabled={busy} onClick={async () => {
              try {
                const [file] = await readClipboardImages();
                await change(file);
              } catch (e) {
                setError((e as Error).message);
              }
            }}>粘贴图片</Button>
            {project.cover_version && (
              <button type="button" className="text-link" disabled={busy}
                onClick={() => { if (window.confirm("移除自定义封面？")) void change(); }}>移除</button>
            )}
          </div>
        </>}
        {busy && <p className="muted" role="status">正在保存封面…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

function ProjectSettings({ project, user, onSaved, onDeleted, canSeed, onSeed }: {
  project: ProjectSummary;
  user: User;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
  canSeed: boolean;
  onSeed: () => void;
}) {
  const [tab, setTab] = usePageState("project-settings.tab", "settings");
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [name, setName] = useState(project.name);
  const [owner, setOwner] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [lifecycle, setLifecycle] = useState<"archive" | "restore" | "delete" | null>(null);
  const admin = user.role === "admin";
  const canEdit = !project.archived_at && (admin || project.owner_id === user.id);
  const projectPath = "projects/" + project.id;
  useEffect(() => {
    let active = true;
    Promise.all([api(projectPath), admin ? api("users") : Promise.resolve([])])
      .then(([item, people]) => {
        if (!active) return;
        setDetails(item);
        setName(item.name);
        setOwner(item.owner_id || "");
        setMembers(item.members);
        setUsers(people);
      })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectPath, admin]);
  async function save(data: unknown) {
    setError("");
    setBusy(true);
    try {
      await api(projectPath, "PUT", data);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>项目设置</h1>
        {admin && <div className="project-lifecycle-actions">
          {project.archived_at ? <>
            <Button type="button" disabled={busy} onClick={() => setLifecycle("restore")}>恢复项目</Button>
            <Button type="button" className="project-delete-action" disabled={busy}
              onClick={() => setLifecycle("delete")}><Trash2 size={15} />删除项目</Button>
          </> : <Button type="button" disabled={busy} onClick={() => setLifecycle("archive")}>
            <Archive size={15} />归档项目
          </Button>}
        </div>}
      </div>
      <div className="tabs page-tabs">
        <button className={tab === "settings" ? "selected" : ""} onClick={() => setTab("settings")}>项目资料</button>
        <button className={tab === "activity" ? "selected" : ""} onClick={() => setTab("activity")}>操作记录</button>
      </div>
      {tab === "activity" ? <ActivityPanel /> : (
        <section className="panel project-settings">
          <ProjectCoverSettings project={project} editable={canEdit} onSaved={onSaved} />
          <form onSubmit={(event) => {
            event.preventDefault();
            void save(admin ? { name, owner_id: owner, members } : { name });
          }}>
            <div className="form-grid">
              <label>项目名称<input required value={name} disabled={!canEdit || busy}
                onChange={(event) => setName(event.target.value)} /></label>
              <label>项目代号<input value={project.code} readOnly /></label>
              {admin && details && (
                <label>项目负责人<select value={owner} disabled={!canEdit || busy}
                  onChange={(event) => setOwner(event.target.value)}>
                  <option value="">未指定</option>
                  {users.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select></label>
              )}
            </div>
            {admin && details && (
              <fieldset className="project-members" disabled={!canEdit || busy}>
                <legend>项目成员</legend>
                {users.map((person) => (
                  <label key={person.id}>
                    <input type="checkbox" checked={person.id === owner || members.includes(person.id)}
                      disabled={person.id === owner}
                      onChange={(event) => setMembers((old) =>
                        event.target.checked ? [...old, person.id] : old.filter((id) => id !== person.id))} />
                    {person.name}
                  </label>
                ))}
              </fieldset>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            {canEdit && <Button primary type="submit" disabled={busy || !details}>保存项目设置</Button>}
          </form>
          {admin && canSeed && <div className="project-settings-actions">
            <Button type="button" disabled={busy} onClick={onSeed}>载入示例数据</Button>
          </div>}
        </section>
      )}
      {lifecycle === "delete" && (
        <Dialog title="删除项目" onClose={() => setLifecycle(null)}>
          <p className="confirm-copy">删除「{project.name}」后，可在项目工作台的「已删除」中撤销。</p>
          <EntityForm
            fields={[{ name: "password", label: "当前管理员密码", type: "password", autoComplete: "current-password", required: true, wide: true }]}
            label="确认删除" onCancel={() => setLifecycle(null)}
            submit={async ({ password }) => {
              await api(projectPath, "DELETE", { password });
              onDeleted();
            }}
          />
        </Dialog>
      )}
      {(lifecycle === "archive" || lifecycle === "restore") && (
        <Dialog title={lifecycle === "archive" ? "归档项目" : "恢复项目"} onClose={() => setLifecycle(null)}>
          <p className="confirm-copy">「{project.name}」{lifecycle === "archive" ? "归档后只能查看。" : "将恢复为进行中。"}</p>
          <AsyncAction label={lifecycle === "archive" ? "确认归档" : "确认恢复"}
            onCancel={() => setLifecycle(null)} action={async () => {
              await api(projectPath, "PUT", { archived: lifecycle === "archive" });
              await onSaved();
              setLifecycle(null);
            }} />
        </Dialog>
      )}
    </>
  );
}

function Workspace({
  route, project, projects, currentUser, navigate, back, canGoBack, draftOpen, reloadProjects,
  updateUser, onLogout, onRestore,
}: {
  route: WorkspaceRoute;
  project?: ProjectSummary;
  projects: ProjectSummary[];
  currentUser: User;
  navigate: (route: WorkspaceRoute, replace?: boolean, initial?: Record<string, unknown>) => void;
  back: (fallback: WorkspaceRoute) => void;
  canGoBack: boolean;
  draftOpen: React.MutableRefObject<boolean>;
  reloadProjects: () => Promise<ProjectSummary[]>;
  updateUser: () => Promise<void>;
  onLogout: () => Promise<void>;
  onRestore: () => void;
}) {
  const [state, setState] = useState<State>(emptyState);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [accountView, setAccountView] = usePageState("workspace.accountView", "profile");
  const { view, detail } = route;
  const projectId = project?.id || "";
  const archived = !!project?.archived_at || !!state.project?.archived_at;
  const userOptions = state.users.map(({ id, name }) => ({ value: id, label: name }));
  const userName = (id: string | null) =>
    state.users.find((user) => user.id === id)?.name ||
    state.former_users.find((user) => user.id === id)?.name || "—";
  const [fatal, setFatal] = useState("");
  const [projectReady, setProjectReady] = useState(!project);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [search, setSearch] = usePageState("workspace.search", "");
  const [filter, setFilter] = usePageState("workspace.filter", view === "products" ? "全部产品" : "全部");
  const [locationFilter, setLocationFilter] = usePageState("workspace.locationFilter", "");
  const [expandedPurchases, setExpandedPurchases] = usePageState<Set<string>>("workspace.expandedPurchases", new Set());
  const [materialLevel, setMaterialLevel] = usePageState("workspace.materialLevel", 1);
  const [selectedLabels, setSelectedLabels] = usePageState<Set<string>>("workspace.selectedLabels", new Set(), false);
  const [printMaterials, setPrintMaterials] = useState<LabelMaterial[] | null>(null);
  const labelSelection = {
    selected: selectedLabels,
    change: (ids: string[], checked: boolean) => setSelectedLabels((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    }),
  };
  const [hiddenColumns, setHiddenColumns] = useState<Record<string, Column[]>>(
    () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("plm-hidden-columns") || "{}",
        );
        return Object.fromEntries(
          ["parts", "inventory", "bom", "children"].map((id) => [
            id,
            Array.isArray(saved?.[id]) ? saved[id] : [],
          ]),
        );
      } catch {
        return {};
      }
    },
  );
  const [parentFilter, setParentFilter] = usePageState("workspace.parentFilter", "");
  const [categories, setCategories] = usePageState<Record<string, string>>("workspace.categories", {});
  const categoryProps = (key: string) => ({
    category: categories[key] || "",
    categoryOptions: state.material_categories,
    setCategory: (value: string) =>
      setCategories((old) => ({ ...old, [key]: value })),
  });
  const matchesCategory = (key: string, part?: Part) =>
    !categories[key] || categories[key] === part?.category;
  const [layout, setLayout] = usePageState("workspace.layout", "grid");
  const [version, setVersion] = usePageState("workspace.version", "");
  const [tab, setTab] = usePageState("workspace.tab", "info");
  const [inventoryDetail, setInventoryDetail] = usePageState<Modal>("workspace.inventoryDetail", null, false);
  const [modal, changeModal] = useState<Modal>(inventoryDetail);
  function setModal(next: Modal) {
    setInventoryDetail(next?.kind === "inventory-part" ? next : null);
    changeModal(next);
  }
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = (s: string) => setToast(s);
  const businessApi = (path: string, method = "GET", data?: unknown) =>
    projectRequest(projectId, path, method, data);

  const refreshSequence = useRef(0);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    if (!projectId) return emptyState;
    try {
      const result = await businessApi("state") as State;
      if (sequence === refreshSequence.current) {
        setState({ ...emptyState, ...result });
        setFatal("");
      }
      return result;
    } catch (e) {
      if (sequence === refreshSequence.current) {
        setState(emptyState);
        setFatal((e as Error).message);
      }
      throw e;
    } finally {
      if (sequence === refreshSequence.current) setProjectReady(true);
    }
  }
  useEffect(() => {
    if (!projectId) return;
    const sync = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    void refresh().catch(() => {});
    const timer = setInterval(sync, 15000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      ++refreshSequence.current;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [projectId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const readOnlyModal = modal && ["scan", "qr", "preview", "material-files", "deleted-parts", "inventory-part"].includes(modal.kind);
  useEffect(() => {
    const hasDraft = !!projectId && (!!choice || (!!modal && !readOnlyModal));
    draftOpen.current = hasDraft;
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      draftOpen.current = false;
      window.removeEventListener("beforeunload", warn);
    };
  }, [projectId, modal, choice]);
  function go(nextView: string, id = "", initial?: Record<string, unknown>) {
    if (!mounted.current) return;
    const next = {
      projectId: ["settings", "projects", "global-shipping"].includes(nextView) ? "" : projectId,
      view: nextView,
      detail: id,
    };
    navigate(next, false, initial);
    setMobile(false);
  }
  function goBack() {
    back({ ...route, detail: "" });
  }
  function openDetailTab(nextTab: string) {
    if (tab !== nextTab) navigate(route, false, { "workspace.tab": nextTab });
  }
  useEffect(() => {
    if (view === "projects") void reloadProjects().catch((e) => setFatal(e.message));
  }, [view]);
  useEffect(() => {
    if (archived && modal && !readOnlyModal) {
      setModal(null);
      notify("项目已归档，只能查看");
    }
  }, [archived, modal, readOnlyModal]);
  async function mutate(
    path: string,
    method: string,
    d?: any,
    message = "已保存",
  ) {
    await businessApi(path, method, d);
    await refresh();
    setModal(null);
    notify(message);
  }
  const findPart = (id: string) =>
    state.parts.find((x) => x.id === id) ||
    state.deleted_parts.find((x) => x.id === id);
  const findProduct = (id: string | null) =>
    state.products.find((x) => x.id === id);
  const findSupplier = (id: string) => state.suppliers.find((x) => x.id === id);
  const files = (owner: string, id: string) =>
    state.files.filter((f) => f.owner_type === owner && f.owner_id === id);
  const Thumb = ({
    owner,
    id,
    large = false,
  }: {
    owner: string;
    id: string;
    large?: boolean;
  }) => {
    const f = files(owner, id).find((f) => f.kind === "image");
    const p = owner === "parts" ? findPart(id) : null;
    return (
      <div
        className={`thumb ${large ? "large" : ""} ${p?.category === "电子物料" ? "electronic" : ""}`}
      >
        {f ? (
          <img
            src={fileUrl(f.id)}
            alt={owner === "parts" ? p?.name : findProduct(id)?.name}
          />
        ) : owner === "parts" ? (
          <Package size={large ? 46 : 22} strokeWidth={1.3} />
        ) : (
          <Box size={large ? 64 : 24} strokeWidth={1.1} />
        )}
      </div>
    );
  };
  const product = state.products.find((p) => p.id === detail);
  const productHasMovements =
    !!product && state.movements.some((row) => row.product_id === product.id);
  const part = findPart(detail);
  const inventoryPart = modal?.kind === "inventory-part" ? findPart(modal.item.id) : undefined;
  const partBomLines = part ? state.bom_lines.filter((line) => line.part_id === part.id) : [];
  const partBomProducts = [...new Set(partBomLines.map((line) =>
    state.bom_versions.find((item) => item.id === line.version_id)?.product_id,
  ))].map((id) => state.products.find((item) => item.id === id)?.name).filter(Boolean);
  const purchase = state.purchases.find((p) => p.id === detail);
  function purchaseMaterialLabel(line: PurchaseLine) {
    const item = findPart(line.part_id);
    return <div className="purchase-material-cell">
      <MaterialThumbnail className="purchase-material-photo"
        imageId={files("parts", line.part_id).find((file) => file.kind === "image")?.id} />
      <div>
        <button type="button" className="text-link" onClick={() => go("parts", line.part_id)}>{item?.name}</button>
        <small className="mono">{item?.code}</small>
      </div>
    </div>;
  }
  function receivedQuantity(line: PurchaseLine) {
    return <><QuantityHighlight value={line.received} tone={line.received > line.qty ? "amber" : "green"} />
      {line.received > line.qty && <small className="purchase-overage">超收 <QuantityHighlight
        value={line.received - line.qty} tone="amber" /></small>}
    </>;
  }
  function pendingQuantity(line: PurchaseLine) {
    const pending = Math.max(0, line.qty - line.received);
    return <QuantityHighlight value={pending} tone={pending ? "amber" : "slate"} />;
  }
  const supplier = findSupplier(detail);
  const suppliedMaterials = supplier
    ? state.quotes.filter((q) => q.supplier_id === supplier.id)
    : [];
  const versions = state.bom_versions.filter((v) => v.product_id === detail);
  const selectedVersion =
    versions.find((v) => v.id === version) || versions[versions.length - 1];
  const match = (...values: any[]) =>
    values.join(" ").toLowerCase().includes(search.toLowerCase());
  const bomAll = state.bom_lines.filter(
    (l) => l.version_id === selectedVersion?.id,
  );
  const bom = bomAll.filter(
    (l) => findPart(l.part_id)?.material_level === materialLevel,
  );
  const displayedBom = bom.filter((line) =>
    matchesCategory("bom", findPart(line.part_id)),
  );
  const selectedBomLabels = bomAll.filter((line) => selectedLabels.has(line.id))
    .map((line) => findPart(line.part_id)).filter((item) => item !== undefined);
  const levelName = materialLevel === 1 ? "一级物料" : "二级物料";
  const levelTabs = (
    <div
      className="tabs material-level-tabs"
      role="tablist"
      aria-label="物料级别"
    >
      {[1, 2].map((level) => (
        <button
          role="tab"
          aria-selected={materialLevel === level}
          key={level}
          className={materialLevel === level ? "selected" : ""}
          onClick={() => {
            setMaterialLevel(level);
            setParentFilter("");
            setSearch("");
            setFilter("全部");
          }}
        >
          {level === 1 ? "一级物料" : "二级物料"}
          <span>
            {view === "products"
              ? bomAll.filter(
                  (l) => findPart(l.part_id)?.material_level === level,
                ).length
              : state.parts.filter((p) => p.material_level === level).length}
          </span>
        </button>
      ))}
    </div>
  );
  const warehouseLocations = [...new Set(state.parts.map((p) => p.location).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const locationChoices = warehouseLocations.map((value) => ({ value, label: value }));
  const inventoryLocation = warehouseLocations.includes(locationFilter) ? locationFilter : "";
  const visibleParts = state.parts.filter(
    (p) =>
      p.material_level === materialLevel &&
      matchesCategory(view, p) &&
      (view !== "inventory" || !inventoryLocation || p.location === inventoryLocation) &&
      (materialLevel !== 2 ||
        !parentFilter ||
        (parentFilter === "unlinked"
          ? !state.material_links.some((l) => l.child_id === p.id)
          : state.material_links.some(
              (l) => l.child_id === p.id && l.parent_id === parentFilter,
            ))) &&
      match(p.name, p.code, p.external_code, p.brand, p.spec, p.location) &&
      (filter === "全部" ||
        p.category === filter ||
        (filter === "低库存" && p.stock < p.min_stock) ||
        (filter === "无库存" && p.stock === 0)),
  );
  async function savePart(id: string, key: string, value: string) {
    await businessApi("material-cells/" + id, "PUT", { [key]: value });
    await refresh();
  }
  async function saveLine(id: string, key: string, value: string) {
    await businessApi("bom-lines/" + id, "PUT", { [key]: value });
    await refresh();
  }
  function materialPhoto(p: Part) {
    return (
      <MaterialPhoto
        name={p.name}
        items={files("parts", p.id).filter((f) => f.kind === "image")}
        preview={(f) => setModal({ kind: "preview", item: f })}
      />
    );
  }
  const childLinks = state.material_links.filter(
    (l) => l.parent_id === part?.id,
  );
  const displayedChildren = childLinks.filter((link) =>
    matchesCategory("children", findPart(link.child_id)),
  );
  const selectedChildLabels = childLinks.filter((link) => selectedLabels.has(link.id))
    .map((link) => findPart(link.child_id)).filter((item) => item !== undefined);
  const parentLinks = state.material_links.filter(
    (l) => l.child_id === part?.id,
  );
  function openMaterial(id: string, section = "info") {
    go("parts", id, section === "info" ? undefined : { "workspace.tab": section });
  }
  function openInventoryPart(id: string) {
    setModal({ kind: "inventory-part", item: { id } });
  }
  function parentsCell(p: Part) {
    return (
      <div className="relation-cell">
        {state.material_links
          .filter((l) => l.child_id === p.id)
          .map((l) => {
            const parent = findPart(l.parent_id);
            return (
              parent && (
                <button
                  className="record-tag"
                  key={l.id}
                  onClick={() => openMaterial(parent.id, "children")}
                >
                  <Package size={11} />
                  {parent.name}
                </button>
              )
            );
          })}
        <button
          className="relation-add"
          title={"选择" + p.name + "关联的一级物料"}
          aria-label={"选择" + p.name + "关联的一级物料"}
          onClick={() => setModal({ kind: "material-parents", item: p })}
        >
          <Plus size={13} />
        </button>
      </div>
    );
  }
  function editMaterial(p: Part) {
    setModal({ kind: "part", item: p });
  }
  function labelPrintButton(material: Part) {
    return <button type="button" title="打印标签" aria-label={"打印标签 " + material.code}
      onClick={() => setPrintMaterials([{ code: material.code, name: material.name }])}>
      <Printer size={15} />
    </button>;
  }
  function batchLabelButton(materials: Part[]) {
    return <Button type="button" small disabled={!materials.length}
      onClick={() => setPrintMaterials(materials.map(({ code, name }) => ({ code, name })))}>
      <Printer size={15} />
      批量打印{materials.length ? `（${materials.length}）` : ""}
    </Button>;
  }
  function materialEditButton(p: Part) {
    if (p.deleted_at) return null;
    return (
      <button
        title="编辑物料"
        aria-label={"编辑物料 " + p.name}
        onClick={() => editMaterial(p)}
      >
        <Pencil size={15} />
      </button>
    );
  }
  function materialCell(
    p: Part,
    field:
      | "spec"
      | "external_code"
      | "brand"
      | "unit"
      | "category"
      | "price"
      | "min_stock"
      | "location"
      | "notes"
      | "material_level",
    label: string,
    options?: Field["options"],
  ) {
    if (p.deleted_at) return p[field] || "—";
    return (
      <InlineCell
        label={p.name + " " + label}
        value={p[field]}
        type={field === "price" || field === "min_stock" ? "number" : "text"}
        options={field === "location" ? [{ value: "", label: "未设置" }, ...locationChoices] : options}
        categoryOptions={field === "category" ? state.material_categories : undefined}
        createOptionLabel={field === "location" ? "搜索或新增库位" : undefined}
        save={(value) => savePart(p.id, field, value)}
      />
    );
  }
  function baseMaterialCells(p: Part, open = openMaterial) {
    return {
      code: (
        <button className="text-link mono" onClick={() => open(p.id)}>
          {p.code}
        </button>
      ),
      photo: materialPhoto(p),
      name: (
        <button
          className="text-link material-name"
          title={p.name}
          onClick={() => open(p.id)}
        >
          {p.name}
          {p.deleted_at && "（已删除）"}
        </button>
      ),
      parents: p.material_level === 2 && !p.deleted_at ? parentsCell(p) : null,
      spec: materialCell(p, "spec", "规格型号"),
      external_code: materialCell(p, "external_code", "外部料号"),
      brand: materialCell(p, "brand", "品牌"),
      unit: materialCell(p, "unit", "单位"),
      category: materialCell(p, "category", "类别"),
      price: materialCell(p, "price", "单价"),
      stock: amount(p.stock),
      custodian: userName(p.custodian_id),
      children:
        p.material_level === 1 ? (
          <button
            className="text-link child-count"
            onClick={() => openMaterial(p.id, "children")}
          >
            {
              state.material_links.filter((link) => link.parent_id === p.id)
                .length
            }{" "}
            项<ChevronRight size={13} />
          </button>
        ) : null,
    };
  }
  function supplierLinkActions(link: Quote) {
    return (
      <div className="row-actions">
        <button
          title="编辑关联"
          onClick={() => setModal({ kind: "quote", item: link })}
        >
          <Pencil size={14} />
        </button>
        <button
          title="解除供应商关联"
          onClick={() => setModal({ kind: "delete-quote", item: link })}
        >
          <X size={15} />
        </button>
      </div>
    );
  }
  function purchaseLink(url: string) {
    return url ? (
      <a className="text-link" href={url} target="_blank" rel="noreferrer">
        采购链接 <ExternalLink size={13} />
      </a>
    ) : null;
  }
  function inventoryRowActions(p: Part, labeled = false) {
    return [
      { label: "入库", icon: ArrowDownToLine },
      { label: "出库", icon: ArrowUpFromLine },
      { label: "退库", icon: RotateCcw },
      { label: "报废", icon: Archive },
    ].map(({ label, icon: Icon }) => (
      <button
        key={label}
        type="button"
        className={labeled ? "btn small" : undefined}
        title={label}
        aria-label={label}
        onClick={() => startInventory(label, p)}
      >
        <Icon size={15} />
        {labeled && label}
      </button>
    ));
  }
  const levelColumns: Column[] = materialLevel === 2 ? ["parents"] : [];
  const childColumns: Column[] = materialLevel === 1 ? ["children"] : [];
  const bomColumns: Column[] = [
    "photo",
    "name",
    "category",
    "custodian",
    ...levelColumns,
    "spec",
    "external_code",
    "brand",
    "unit",
    "qty",
    "price",
    "subtotal",
    "stock",
    "reference",
    "notes",
    ...childColumns,
  ];
  const libraryColumns: Column[] = [
    "photo",
    "name",
    "category",
    "custodian",
    ...levelColumns,
    "spec",
    "external_code",
    "brand",
    "unit",
    "price",
    "stock",
    "min_stock",
    "location",
    "notes",
    "level",
    ...childColumns,
  ];
  const childrenColumns: Column[] = [
    "photo",
    "name",
    "category",
    "custodian",
    "spec",
    "external_code",
    "brand",
    "unit",
    "qty",
    "price",
    "stock",
    "reference",
    "notes",
    "parents",
  ];
  function displayFields(tableId: string, columns: Column[]) {
    return (
      <ColumnVisibility
        columns={columns}
        hidden={hiddenColumns[tableId] || []}
        onChange={(hidden) => {
          const next = { ...hiddenColumns, [tableId]: hidden };
          setHiddenColumns(next);
          if (hidden.includes("category") && categories[tableId])
            categoryProps(tableId).setCategory("");
          try {
            localStorage.setItem("plm-hidden-columns", JSON.stringify(next));
          } catch {
            /* Available for this session. */
          }
        }}
      />
    );
  }
  const bomCost = (pid: string) => {
    const vs = state.bom_versions.filter((v) => v.product_id === pid);
    return state.bom_lines
      .filter((l) => l.version_id === vs.at(-1)?.id)
      .reduce((s, l) => s + (findPart(l.part_id)?.price || 0) * l.qty, 0);
  };
  function costStatus(p: Purchase) {
    const lines = state.purchase_lines.filter((l) => l.purchase_id === p.id);
    return lines.every((l) => l.received >= l.qty)
      ? "已全部入库"
      : lines.some((l) => l.received > 0)
        ? "部分入库"
        : "待入库";
  }
  const low = state.parts.filter((p) => p.stock < p.min_stock);
  const title = navs.find((n) => n.id === view)?.name ||
    ({ projects: "项目列表", "global-shipping": "全局发货", settings: "系统设置", "project-settings": "项目设置" }[view] || "工作空间");
  const partOptions = state.parts.map((p) => ({
    value: p.id,
    label: p.code + " · " + p.name + " / 库存 " + amount(p.stock),
  }));
  const productOptions = state.products.map((p) => ({
    value: p.id,
    label: p.name,
  }));
  const supplierOptions = state.suppliers.map((s) => ({
    value: s.id,
    label: s.name,
  }));
  const productFields: Field[] = [
    { name: "name", label: "名称", required: true, wide: true },
    {
      name: "english_code",
      label: "英文代号",
      placeholder: "例如 AQUAMIX",
      wide: true,
    },
    {
      name: "status",
      label: "状态",
      options: ["研发中", "已定版", "已归档"].map((x) => ({
        value: x,
        label: x,
      })),
    },
    { name: "manager_id", label: "产品经理", options: userOptions, wide: true },
    { name: "description", label: "备注", type: "textarea", wide: true },
  ];
  const partFields: Field[] = [
    { name: "name", label: "名称", required: true, wide: true },
    {
      name: "material_level",
      label: "级别",
      options: [
        { value: "1", label: "一级物料" },
        { value: "2", label: "二级物料" },
      ],
    },
    {
      name: "category",
      label: "类别",
      categoryOptions: state.material_categories,
    },
    {
      name: "custodian_id",
      label: "物料管理员",
      options: [
        ...userOptions,
        ...state.former_users
          .filter(({ id }) => modal?.kind === "part" && modal.item?.custodian_id === id)
          .map(({ id, name }) => ({ value: id, label: name })),
      ],
      wide: true,
    },
    { name: "external_code", label: "外部料号" },
    { name: "brand", label: "品牌" },
    { name: "spec", label: "规格 / 封装", wide: true },
    { name: "unit", label: "单位" },
    { name: "price", label: "单价", type: "number" },
    { name: "min_stock", label: "最低库存", type: "number" },
    { name: "location", label: "仓库位置" },
    { name: "notes", label: "备注", type: "textarea", wide: true },
  ];
  const supplierFields: Field[] = [
    { name: "name", label: "供应商名称", required: true, wide: true },
    { name: "contact", label: "联系人" },
    { name: "phone", label: "联系电话" },
    { name: "email", label: "邮箱", type: "email" },
    { name: "address", label: "地址" },
    { name: "notes", label: "备注", type: "textarea", wide: true },
  ];
  function fileManager(owner: string, id: string) {
    return (
      <FileManager
        owner={owner}
        id={id}
        items={files(owner, id)}
        onRefresh={refresh}
        onError={notify}
        onPreview={(f) => setModal({ kind: "preview", item: f })}
        onDelete={(f) => setModal({ kind: "delete-file", item: f })}
      />
    );
  }
  function movementTable(rows: Movement[], limit = rows.length) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>操作 / 单号</th>
              <th>物料</th>
              <th className="num">数量</th>
              <th className="num">结存</th>
              <th>关联记录</th>
              <th>经办人</th>
              <th>用途 / 原因</th>
              <th>操作时间</th>
              {!archived && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {recentMovements(rows).slice(0, limit)
              .map((m) => {
                const p = findPart(m.part_id);
                const pl = state.purchase_lines.find(
                  (l) => l.id === m.purchase_line_id,
                );
                const po = state.purchases.find(
                  (x) => x.id === pl?.purchase_id,
                );
                return (
                  <tr key={m.id}>
                    <td>
                      <OptionTag label={m.type} />
                      <small className="mono">{m.code}</small>
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => {
                          if (view === "inventory") openInventoryPart(m.part_id);
                          else go("parts", m.part_id);
                        }}
                      >
                        {p?.name}
                      </button>
                      <small className="mono">{p?.code}</small>
                    </td>
                    <td className="num">
                      <QuantityHighlight value={m.qty}
                        prefix={["入库", "退库"].includes(m.type) ? "+" : "−"}
                        tone={["入库", "退库"].includes(m.type) ? "green" : "rose"} /> {p?.unit}
                    </td>
                    <td className="num"><QuantityHighlight value={m.balance} tone={m.balance === 0 ? "slate" : "blue"} /></td>
                    <td>
                      {po ? (
                        <button
                          className="text-link"
                          onClick={() => go("purchases", po.id)}
                        >
                          {po.code}
                        </button>
                      ) : (
                        findProduct(m.product_id)?.name || "独立操作"
                      )}
                      {m.original_id && (
                        <small>
                          原出库：
                          {
                            state.movements.find((x) => x.id === m.original_id)
                              ?.code
                          }
                        </small>
                      )}
                    </td>
                    <td>{userName(m.handler_id)}</td>
                    <td>{m.reason || "—"}</td>
                    <td className="muted nowrap" title={"登记时间 " + datetime(m.created_at)}>{datetime(m.occurred_at)}</td>
                    {!archived && <td>{p && !p.deleted_at && (
                      <Button type="button" small aria-label={"编辑流水 " + m.code}
                        onClick={() => setModal({ kind: "movement", item: m })}>
                        <Pencil size={13} />编辑
                      </Button>
                    )}</td>}
                  </tr>
                );
              })}
          </tbody>
        </table>
        {!rows.length && <Empty title="暂无流水" />}
      </div>
    );
  }
  function startInventory(type: string, p?: Part, extra?: any) {
    setModal({
      kind: "movement",
      item: {
        type,
        part_id: p?.id || "",
        qty: "",
        handler_id: currentUser?.id,
        ...extra,
      },
    });
  }
  function exportBom() {
    exportCSV(
      displayedBom.map((l) => {
        const p = findPart(l.part_id)!;
        return {
          物料编码: p.code,
          物料名称: p.name,
          级别: p.material_level,
          类别: p.category,
          规格型号: p.spec,
          数量: l.qty,
          单位: p.unit,
          参考单价: p.price,
          小计: Math.round(p.price * l.qty * 10000) / 10000,
          位号: l.reference,
          备注: l.notes,
        };
      }),
      (product?.english_code || product?.code || "BOM") +
        "-" +
        selectedVersion?.name,
    );
  }
  return (
    <ProjectContext.Provider value={{ id: projectId, archived }}>
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <a className="brand" href="#projects" onClick={(event) => { event.preventDefault(); go("projects"); }}>
          <BrandMark />
          <strong>捷程未来PLM</strong>
        </a>
        {project && (
          <label className="project-switch">
            <span>当前项目</span>
            <select aria-label="切换项目" value={project.id} onChange={(event) => {
              navigate({ projectId: event.target.value, view: navs.some((nav) => nav.id === view) ? view : "products", detail: "" });
            }}>
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived_at ? "（已归档）" : ""}</option>)}
            </select>
          </label>
        )}
        <nav>
          <button className={view === "projects" ? "active" : ""} onClick={() => go("projects")}>
            <Layers size={19} strokeWidth={1.7} /><span>项目列表</span>
          </button>
          <button className={view === "global-shipping" ? "active" : ""} onClick={() => go("global-shipping")}>
            <Truck size={19} strokeWidth={1.7} /><span>全局发货</span>
          </button>
          {project && navs.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "active" : ""}
              onClick={() => go(n.id)}
            >
              <n.icon size={19} strokeWidth={1.7} />
              <span>{n.name}</span>
              {n.id === "products" && (
                <span className="nav-count">{state.products.length}</span>
              )}
              {n.id === "parts" && (
                <span className="nav-count">{state.parts.length}</span>
              )}
            </button>
          ))}
          {project && <button className={view === "project-settings" ? "active" : ""} onClick={() => go("project-settings")}>
            <Settings size={19} strokeWidth={1.7} /><span>项目设置</span>
          </button>}
        </nav>
        <div className="sidebar-bottom">
          {project && !fatal && <button onClick={() => setModal({ kind: "scan" })}>
            <ScanLine size={18} />
            扫码识别物料<span className="key">↵</span>
          </button>}
          <button onClick={() => go("settings")}>
            <Settings size={18} />
            系统设置
          </button>
          <div className="user-row">
            <Avatar user={currentUser} version={avatarVersion} />
            <div>
              <button
                className="text-link"
                onClick={() => {
                  go("settings", "", { "workspace.accountView": "profile" });
                }}
              >
                <strong>{currentUser?.name}</strong>
              </button>
              <span>{currentUser?.role === "admin" ? "管理员" : "成员"}</span>
            </div>
            <button
              className="icon-btn"
              title="退出登录"
              onClick={onLogout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && (
        <div className="mobile-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-btn mobile-menu"
            aria-label="打开菜单"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          {(!detail ? canGoBack : ["shipping", "global-shipping", "inspection"].includes(view)) &&
            <button className="icon-btn topbar-back" type="button" aria-label="返回上一页" title="返回上一页" onClick={goBack}>
              <ArrowLeft size={18} />
            </button>}
          <div className="breadcrumb">
            {project && <>
              <button onClick={() => go("projects")}>项目</button>
              <ChevronRight size={14} />
              <button onClick={() => go("products")}>{project.name}</button>
              <ChevronRight size={14} />
            </>}
            <button onClick={() => go(view)}>{title}</button>
            {detail && view !== "shipping" && view !== "global-shipping" && (
              <>
                <ChevronRight size={14} />
                <span className="current">
                  {product?.name ||
                    part?.name ||
                    supplier?.name ||
                    purchase?.code}
                </span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className="today">
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
            <span className="topbar-separator" />
            <button
              aria-label="个人资料"
              onClick={() => {
                go("settings", "", { "workspace.accountView": "profile" });
              }}
            >
              <Avatar user={currentUser} version={avatarVersion} small />
            </button>
          </div>
        </header>
        <main>
          {fatal && (
            <div className="form-error">
              {fatal}
              <Button
                onClick={() => {
                  if (project) void refresh().catch(() => {});
                  else void reloadProjects().then(() => setFatal(""), (e) => setFatal(e.message));
                }}
              >
                重试
              </Button>
            </div>
          )}
          {project && !projectReady && <p className="muted">正在加载项目…</p>}
          {archived && !fatal && <p className="project-archived" role="status">项目已归档，只能查看</p>}
          {projectReady && !fatal && <>
          {view === "projects" && <ProjectDirectory projects={projects}
            open={(id) => navigate({ projectId: id, view: "products", detail: "" })}
            onRecovered={reloadProjects}
            create={currentUser.role === "admin" ? async (name) => {
              const result = await api("projects", "POST", { name });
              await reloadProjects();
              navigate({ projectId: result.id, view: "products", detail: "" });
            } : undefined}
          />}
          {view === "inspection" && project && <ProductionInspection
            request={businessApi}
            baseUrl={appBase + "api/projects/" + encodeURIComponent(project.id) + "/"}
            admin={currentUser.role === "admin"}
            readOnly={archived}
            onDraftChange={(dirty) => { draftOpen.current = dirty; }}
          />}
          {view === "shipping" && project && <Suspense fallback={<p className="muted">正在加载发货管理…</p>}>
            <ShippingManagement key={detail} request={businessApi} admin={currentUser.role === "admin"} readOnly={archived}
              products={state.products.map((product) => ({
                id: product.id, name: product.name, code: product.code, english_code: product.english_code,
                project_id: project.id, project_name: project.name,
                image_id: files("products", product.id).find((file) => file.kind === "image")?.id,
              })).sort((a, b) => a.code.localeCompare(b.code))}
              initialRecord={detail}
              onDraftChange={(dirty) => { draftOpen.current = dirty; }} />
          </Suspense>}
          {view === "global-shipping" && <Suspense fallback={<p className="muted">正在加载全局发货…</p>}>
            <GlobalShipping key={detail} initialRecord={detail} request={api}
              projectRequest={(id) => (path, method, data) => projectRequest(id, path, method, data)}
              onDraftChange={(dirty) => { draftOpen.current = dirty; }} />
          </Suspense>}
          {view === "project-settings" && project && (
            <ProjectSettings project={{ ...project, ...state.project }} user={currentUser}
              onDeleted={() => go("projects")} onSaved={async () => {
              await reloadProjects();
              await refresh();
            }} canSeed={!archived && !state.products.length && !state.parts.length &&
              !state.deleted_parts.length && !state.suppliers.length && !state.movements.length &&
              !state.purchases.length}
              onSeed={() => setModal({ kind: "demo" })} />
          )}
          {view === "products" && !detail && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    产品管理{" "}
                    <span className="heading-count">
                      {state.products.length}
                    </span>
                  </h1>
                </div>
                <Button
                  primary
                  onClick={() =>
                    setModal({ kind: "product", item: { status: "研发中" } })
                  }
                >
                  <Plus size={17} />
                  新建产品
                </Button>
              </div>
              <div className="stats-row">
                <div>
                  <span className="stat-label">
                    <Boxes size={16} />
                    产品总数
                  </span>
                  <strong>
                    {state.products.length}
                    <small>个产品</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-label">
                    <Layers size={16} />
                    研发进行中
                  </span>
                  <strong>
                    {state.products.filter((p) => p.status === "研发中").length}
                    <small>个产品</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-label">
                    <Package size={16} />
                    物料
                  </span>
                  <strong>
                    {state.parts.length}
                    <small>种物料</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-label">
                    <ShoppingCart size={16} />
                    待入库采购
                  </span>
                  <strong>
                    {
                      state.purchases.filter(
                        (p) => costStatus(p) !== "已全部入库",
                      ).length
                    }
                    <small>张采购单</small>
                  </strong>
                </div>
              </div>
              <div className="section-toolbar">
                <div className="tabs">
                  {["全部产品", "研发中", "已定版", "已归档"].map((t) => (
                    <button
                      key={t}
                      className={filter === t ? "selected" : ""}
                      onClick={() => setFilter(t)}
                    >
                      {t}
                      {t === "全部产品" && <span>{state.products.length}</span>}
                    </button>
                  ))}
                </div>
                <div className="toolbar-controls">
                  <div className="search-input">
                    <Search size={16} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索名称、英文代号…"
                      aria-label="搜索产品"
                    />
                    {search && (
                      <button
                        aria-label="清除搜索"
                        onClick={() => setSearch("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <div className="view-switch">
                    <button
                      aria-label="卡片视图"
                      className={layout === "grid" ? "selected" : ""}
                      onClick={() => setLayout("grid")}
                    >
                      <Grid2X2 size={17} />
                    </button>
                    <button
                      aria-label="列表视图"
                      className={layout === "list" ? "selected" : ""}
                      onClick={() => setLayout("list")}
                    >
                      <List size={18} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="results-label">
                {filter === "全部产品" ? "所有产品" : filter}
                <span>
                  {
                    state.products.filter(
                      (p) =>
                        (filter === "全部产品" || p.status === filter) &&
                        match(p.name, p.code, p.english_code),
                    ).length
                  }{" "}
                  个产品
                </span>
              </div>
              <div
                className={layout === "grid" ? "product-grid" : "product-list"}
              >
                {state.products
                  .filter(
                    (p) =>
                      (filter === "全部产品" || p.status === filter) &&
                      match(p.name, p.code, p.english_code),
                  )
                  .map((p) => {
                    const vs = state.bom_versions.filter(
                      (v) => v.product_id === p.id,
                    );
                    const lines = state.bom_lines.filter(
                      (l) => l.version_id === vs.at(-1)?.id,
                    );
                    return (
                      <article className="product-card" key={p.id}>
                        <button
                          className="product-visual"
                          onClick={() => go("products", p.id)}
                          aria-label={"查看 " + p.name}
                        >
                          <Thumb owner="products" id={p.id} large />
                          {!files("products", p.id).some(
                            (f) => f.kind === "image",
                          ) && (
                            <span className="visual-caption">
                              {p.english_code || p.code}
                            </span>
                          )}
                        </button>
                        <div className="product-card-body">
                          <div className="card-meta">
                            <span className="mono">
                              {p.english_code || p.code}
                            </span>
                            <Badge>{p.status}</Badge>
                          </div>
                          <button
                            className="card-title"
                            onClick={() => go("products", p.id)}
                          >
                            {p.name}
                            <ArrowUpRight size={18} />
                          </button>
                          {p.manager_id && (
                            <p>产品经理：{userName(p.manager_id)}</p>
                          )}
                          {p.description && <p>{p.description}</p>}
                          <div className="card-details">
                            <div>
                              <span>BOM 版本</span>
                              <strong>{vs.at(-1)?.name || "尚无版本"}</strong>
                            </div>
                            <div>
                              <span>物料数量</span>
                              <strong>
                                {lines.length}
                                <small>种</small>
                              </strong>
                            </div>
                            <div>
                              <span>参考成本</span>
                              <strong>{money(bomCost(p.id))}</strong>
                            </div>
                          </div>
                          <div className="card-footer">
                            <span>更新于 {date(p.updated_at)}</span>
                            <button onClick={() => go("products", p.id)}>
                              查看 BOM
                              <ChevronRight size={14} />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                {!search && filter === "全部产品" && (
                  <button
                    className="new-product-card"
                    onClick={() =>
                      setModal({ kind: "product", item: { status: "研发中" } })
                    }
                  >
                    <span>
                      <Plus size={25} />
                    </span>
                    <strong>新建产品</strong>
                  </button>
                )}
              </div>
              {!state.products.length && (
                <div className="demo-action">
                  <Button small onClick={() => setModal({ kind: "demo" })}>
                    载入示例数据
                  </Button>
                </div>
              )}
            </>
          )}
          {view === "products" && detail && product && (
            <>
              <div className="detail-heading">
                <button className="back-btn" aria-label="返回上一页" onClick={goBack}>
                  <ArrowLeft size={18} />
                </button>
                <Thumb owner="products" id={product.id} />
                <div className="detail-title">
                  <div className="inline">
                    <h1>{product.name}</h1>
                    <Badge>{product.status}</Badge>
                  </div>
                  <p>
                    <span className="mono">
                      {product.english_code || product.code}
                    </span>
                    <span>·</span>
                    {product.description}
                  </p>
                  <p>产品经理：{userName(product.manager_id)}</p>
                </div>
                <Button
                  onClick={() => setModal({ kind: "product", item: product })}
                >
                  <Pencil size={16} />
                  编辑产品
                </Button>
              </div>
              <div className="tabs page-tabs">
                {[
                  ["info", "产品 BOM"],
                  ["files", "图片与附件"],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    className={tab === id ? "selected" : ""}
                    onClick={() => setTab(id)}
                  >
                    {name}
                    {id === "files" && (
                      <span>{files("products", product.id).length}</span>
                    )}
                  </button>
                ))}
              </div>
              {tab === "files" ? (
                fileManager("products", product.id)
              ) : (
                <>
                  <div className="bom-version-bar">
                    <select
                      aria-label="BOM 版本"
                      value={selectedVersion?.id || ""}
                      onChange={(e) => setVersion(e.target.value)}
                    >
                      {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <Button small onClick={() => setModal({ kind: "version" })}>
                      <Copy size={14} />
                      新建版本
                    </Button>
                    <span className="bom-total">
                      合计{" "}
                      <strong>
                        {money(
                          bomAll.reduce(
                            (sum, l) =>
                              sum + (findPart(l.part_id)?.price || 0) * l.qty,
                            0,
                          ),
                        )}
                      </strong>
                    </span>
                  </div>
                  <div className="section-toolbar">
                    {levelTabs}
                    <div className="toolbar-controls">
                      {displayFields("bom", bomColumns)}
                      {batchLabelButton(selectedBomLabels)}
                      <Button
                        small
                        onClick={() =>
                          setModal(
                            materialLevel === 2
                              ? {
                                  kind: "electronic-import",
                                  extra: {
                                    version_id: selectedVersion?.id,
                                  },
                                }
                              : { kind: "import" },
                          )
                        }
                      >
                        <Upload size={15} />
                        导入
                      </Button>
                      <Button
                        small
                        disabled={!displayedBom.length}
                        onClick={exportBom}
                      >
                        <Download size={15} />
                        导出
                      </Button>
                      <Button
                        small
                        onClick={() =>
                          setModal({
                            kind: "bom-line",
                            item: { version_id: selectedVersion?.id, qty: 1 },
                          })
                        }
                      >
                        <Plus size={15} />
                        添加已有物料
                      </Button>
                      <Button
                        small
                        primary
                        onClick={() => setModal({ kind: "bom-create" })}
                      >
                        <Plus size={15} />
                        新建物料
                      </Button>
                    </div>
                  </div>
                  <MaterialTable
                    tableId="bom"
                    selection={labelSelection}
                    {...categoryProps("bom")}
                    columns={bomColumns}
                    hiddenColumns={hiddenColumns["bom"] || []}
                    rows={displayedBom.map((line) => {
                      const material = findPart(line.part_id)!;
                      return {
                        id: line.id,
                        selectionLabel: material.code,
                        cells: {
                          ...baseMaterialCells(material),
                          qty: material.deleted_at ? (
                            line.qty
                          ) : (
                            <InlineCell
                              label={material.name + " 用量"}
                              value={line.qty}
                              type="number"
                              min={0.000001}
                              save={(value) => saveLine(line.id, "qty", value)}
                            />
                          ),
                          subtotal: money(material.price * line.qty),
                          reference: material.deleted_at ? (
                            line.reference
                          ) : (
                            <InlineCell
                              label={material.name + " 位号"}
                              value={line.reference}
                              save={(value) =>
                                saveLine(line.id, "reference", value)
                              }
                            />
                          ),
                          notes: material.deleted_at ? (
                            line.notes
                          ) : (
                            <InlineCell
                              label={material.name + " 备注"}
                              value={line.notes}
                              save={(value) =>
                                saveLine(line.id, "notes", value)
                              }
                            />
                          ),
                          actions: (
                            <div className="row-actions">
                              {materialEditButton(material)}
                              {labelPrintButton(material)}
                              <button
                                title="查看物料"
                                onClick={() => openMaterial(material.id)}
                              >
                                <ArrowUpRight size={15} />
                              </button>
                              <button
                                aria-label={"移除 " + material.name}
                                onClick={() =>
                                  setModal({ kind: "delete-line", item: line })
                                }
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          ),
                        },
                      };
                    })}
                    empty={
                      <Empty
                        title={
                          categories.bom
                            ? "没有符合类别的物料"
                            : "暂无" + levelName
                        }
                        action={
                          !categories.bom && (
                            <Button
                              small
                              onClick={() => setModal({ kind: "bom-create" })}
                            >
                              <Plus size={15} />
                              新建物料
                            </Button>
                          )
                        }
                      />
                    }
                  />
                </>
              )}
              <div className="danger-footer">
                <Button
                  small
                  disabled={
                    productHasMovements || currentUser?.role !== "admin"
                  }
                  onClick={() =>
                    setModal({ kind: "delete-product", item: product })
                  }
                >
                  <Trash2 size={14} />
                  删除产品
                </Button>
                {productHasMovements ? (
                  <span>
                    此产品有关联的库存流水，可在编辑产品中设为已归档。
                  </span>
                ) : (
                  currentUser?.role !== "admin" && (
                    <span>只有管理员可以删除产品。</span>
                  )
                )}
              </div>
            </>
          )}
          {(view === "parts" || view === "inventory") && !detail && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    {view === "parts" ? "物料库" : "库存查询"}{" "}
                    <span className="heading-count">{state.parts.length}</span>
                  </h1>
                </div>
                {view === "parts" ? (
                  <div className="toolbar-controls">
                    {!!state.deleted_parts.length && (
                      <Button
                        onClick={() => setModal({ kind: "deleted-parts" })}
                      >
                        <Archive size={15} />
                        已删除物料
                      </Button>
                    )}
                    <Button primary onClick={() => setModal({ kind: "part" })}>
                      <Plus size={17} />
                      新建物料
                    </Button>
                  </div>
                ) : (
                  <div className="toolbar-controls">
                    <Button onClick={() => startInventory("出库")}>
                      <ArrowUpFromLine size={16} />
                      出库
                    </Button>
                    <Button primary onClick={() => startInventory("入库")}>
                      <ArrowDownToLine size={16} />
                      入库
                    </Button>
                  </div>
                )}
              </div>
              {view === "inventory" && (
                <div className="stats-row">
                  <div>
                    <span className="stat-label">物料种类</span>
                    <strong>
                      {state.parts.length}
                      <small>种</small>
                    </strong>
                  </div>
                  <div>
                    <span className="stat-label">有库存物料</span>
                    <strong>
                      {state.parts.filter((p) => p.stock > 0).length}
                      <small>种</small>
                    </strong>
                  </div>
                  <div>
                    <span className="stat-label">低于最低库存</span>
                    <strong>
                      {low.length}
                      <small>种</small>
                    </strong>
                  </div>
                  <div>
                    <span className="stat-label">库存参考价值</span>
                    <strong className="money-stat">
                      {money(
                        state.parts.reduce((s, p) => s + p.stock * p.price, 0),
                      )}
                    </strong>
                  </div>
                </div>
              )}
              <div className="section-toolbar">
                {levelTabs}
                <div className="toolbar-controls">
                  {view === "parts" && materialLevel === 2 && (
                    <Button
                      small
                      onClick={() =>
                        setModal({ kind: "electronic-import", extra: {} })
                      }
                    >
                      <Upload size={15} />
                      导入 Excel
                    </Button>
                  )}
                  {materialLevel === 2 && (
                    <select
                      className="parent-filter"
                      aria-label="筛选关联一级物料"
                      value={parentFilter}
                      onChange={(e) => setParentFilter(e.target.value)}
                    >
                      <option value="">全部关联</option>
                      <option value="unlinked">未关联</option>
                      {state.parts
                        .filter((p) => p.material_level === 1)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  )}
                  <div className="material-search-controls">
                    <div className="search-input">
                      <Search size={16} />
                      <input
                        aria-label="搜索物料"
                        placeholder="搜索物料"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    {displayFields(view, libraryColumns)}
                  </div>
                  {view === "inventory" && (
                    <>
                      <select className="stock-filter" aria-label="库存筛选" value={filter}
                        onChange={(e) => setFilter(e.target.value)}>
                        {["全部", "低库存", "无库存"].map((t) => <option key={t}>{t}</option>)}
                      </select>
                      <select className="stock-filter" aria-label="筛选仓库位置" value={inventoryLocation}
                        onChange={(e) => setLocationFilter(e.target.value)}>
                        <option value="">全部库位</option>
                        {warehouseLocations.map((location) => <option key={location}>{location}</option>)}
                      </select>
                    </>
                  )}
                  <Button small onClick={() => setModal({ kind: "scan" })}>
                    <ScanLine size={16} />
                  </Button>
                  <Button
                    small
                    onClick={() =>
                      exportCSV(
                        visibleParts.map((p) => ({
                          物料编码: p.code,
                          名称: p.name,
                          级别: p.material_level,
                          规格型号: p.spec,
                          单位: p.unit,
                          库存: p.stock,
                          单价: p.price,
                          仓库位置: p.location,
                        })),
                        "物料库存",
                      )
                    }
                  >
                    <Download size={15} />
                  </Button>
                </div>
              </div>
              <MaterialTable
                key={view}
                tableId={view}
                {...categoryProps(view)}
                columns={libraryColumns}
                hiddenColumns={hiddenColumns[view] || []}
                rows={visibleParts.map((material) => ({
                  id: material.id,
                  cells: {
                    ...baseMaterialCells(material, view === "inventory" ? openInventoryPart : openMaterial),
                    stock: view === "inventory" ? <InventoryQuantity part={material} /> : amount(material.stock),
                    min_stock: materialCell(material, "min_stock", "最低库存"),
                    location: materialCell(material, "location", "仓库位置"),
                    notes: materialCell(material, "notes", "备注"),
                    level: materialCell(material, "material_level", "级别", [
                      { value: "1", label: "一级物料" },
                      { value: "2", label: "二级物料" },
                    ]),
                    actions: (
                      <div className="row-actions">
                        {view === "inventory" ? (
                          inventoryRowActions(material)
                        ) : (
                          <>
                            {materialEditButton(material)}
                            <button
                              title="物料二维码"
                              onClick={() =>
                                setModal({ kind: "qr", item: material })
                              }
                            >
                              <QrCode size={15} />
                            </button>
                            <button
                              title="图片与附件"
                              aria-label={material.name + "的图片与附件"}
                              onClick={() =>
                                setModal({
                                  kind: "material-files",
                                  item: material,
                                })
                              }
                            >
                              <Paperclip size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    ),
                  },
                }))}
                empty={<Empty title="暂无物料" />}
              />
            </>
          )}
          {view === "parts" && detail && part?.deleted_at && (
            <>
              <div className="detail-heading">
                <button
                  className="back-btn"
                  aria-label="返回上一页"
                  onClick={goBack}
                >
                  <ArrowLeft size={18} />
                </button>
                <div className="detail-title">
                  <h1>
                    {part.name} <Badge>已删除</Badge>
                  </h1>
                  <p>
                    {part.code} · 库存 {amount(part.stock)} {part.unit}
                  </p>
                </div>
                <Button
                  onClick={() =>
                    mutate("deleted-parts/" + part.id, "PUT", {}, "物料已恢复")
                  }
                >
                  恢复物料
                </Button>
              </div>
              <ActivityPanel key={part.id} part={part.id} />
              {movementTable(
                state.movements.filter((row) => row.part_id === part.id),
              )}
            </>
          )}
          {view === "parts" && detail && part && !part.deleted_at && (
            <>
              <div className="detail-heading">
                <button className="back-btn" aria-label="返回上一页" onClick={goBack}>
                  <ArrowLeft size={18} />
                </button>
                <Thumb owner="parts" id={part.id} />
                <div className="detail-title">
                  <div className="inline">
                    <h1>{part.name}</h1>
                    <Badge>{part.category}</Badge>
                  </div>
                  <p className="mono">{part.code}</p>
                </div>
                {part.material_level === 1 && (
                  <Button onClick={() => openDetailTab("children")}>
                    <Layers size={16} />
                    二级物料 <span>{childLinks.length}</span>
                  </Button>
                )}
                <Button onClick={() => setModal({ kind: "qr", item: part })}>
                  <QrCode size={16} />
                  二维码
                </Button>
                <Button onClick={() => setModal({ kind: "part", item: part })}>
                  <Pencil size={16} />
                  编辑
                </Button>
              </div>
              <div className="part-overview">
                <div>
                  <span>当前库存</span>
                  <strong>
                    {amount(part.stock)}
                    <small>{part.unit}</small>
                  </strong>
                  <p>
                    最低库存 {amount(part.min_stock)} {part.unit}
                  </p>
                </div>
                <div>
                  <span>参考单价</span>
                  <strong>{money(part.price)}</strong>
                  <p>库位：{part.location || "未设置"}</p>
                </div>
                <div className="inventory-quick">
                  <span>库存操作</span>
                  <div>
                    {[
                      ["入库", ArrowDownToLine],
                      ["出库", ArrowUpFromLine],
                      ["退库", RotateCcw],
                      ["报废", Archive],
                    ].map(([t, I]) => {
                      const Icon = I as typeof Box;
                      return (
                        <Button
                          key={String(t)}
                          small
                          onClick={() => startInventory(String(t), part)}
                        >
                          <Icon size={15} />
                          {String(t)}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="tabs page-tabs">
                {[
                  ["info", "基本资料"],
                  ...(part.material_level === 1
                    ? [["children", "二级物料 (" + childLinks.length + ")"]]
                    : [["parents", "关联一级物料"]]),
                  ["files", "图片与附件"],
                  ["boms", "关联 BOM"],
                  ["purchases", "采购记录"],
                  ["history", "库存流水"],
                  ["activity", "操作记录"],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    className={tab === id ? "selected" : ""}
                    onClick={() => setTab(id)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {tab === "children" && part.material_level === 1 && (
                <>
                  <div className="section-toolbar">
                    <h3>
                      二级物料{" "}
                      <span className="muted">{childLinks.length}</span>
                    </h3>
                    <div className="toolbar-controls">
                      {displayFields("children", childrenColumns)}
                      {batchLabelButton(selectedChildLabels)}
                      <Button
                        small
                        onClick={() =>
                          setModal({
                            kind: "electronic-import",
                            extra: {
                              parent_id: part.id,
                            },
                          })
                        }
                      >
                        <Upload size={15} />
                        导入 Excel
                      </Button>
                      <Button
                        small
                        onClick={() =>
                          setModal({ kind: "material-children", item: part })
                        }
                      >
                        <LinkIcon size={14} />
                        关联已有物料
                      </Button>
                      <Button
                        small
                        primary
                        onClick={() =>
                          setModal({
                            kind: "child-create",
                            extra: { parent_id: part.id, level: 2 },
                          })
                        }
                      >
                        <Plus size={15} />
                        新增二级物料
                      </Button>
                    </div>
                  </div>
                  <MaterialTable
                    tableId="children"
                    selection={labelSelection}
                    {...categoryProps("children")}
                    columns={childrenColumns}
                    hiddenColumns={hiddenColumns["children"] || []}
                    rows={displayedChildren.map((link) => {
                      const child = findPart(link.child_id)!;
                      const saveLink = async (
                        field: "qty" | "reference" | "notes",
                        value: string,
                      ) => {
                        await businessApi("material-links/" + link.id, "PUT", {
                          [field]: value,
                        });
                        await refresh();
                      };
                      return {
                        id: link.id,
                        selectionLabel: child.code,
                        cells: {
                          ...baseMaterialCells(child),
                          qty: child.deleted_at ? (
                            link.qty
                          ) : (
                            <InlineCell
                              label={child.name + " 关联用量"}
                              value={link.qty}
                              type="number"
                              min={0.000001}
                              save={(value) => saveLink("qty", value)}
                            />
                          ),
                          price: money(child.price),
                          reference: child.deleted_at ? (
                            link.reference
                          ) : (
                            <InlineCell
                              label={child.name + " 关联位号"}
                              value={link.reference}
                              save={(value) => saveLink("reference", value)}
                            />
                          ),
                          notes: child.deleted_at ? (
                            link.notes
                          ) : (
                            <InlineCell
                              label={child.name + " 关联备注"}
                              value={link.notes}
                              save={(value) => saveLink("notes", value)}
                            />
                          ),
                          actions: (
                            <div className="row-actions">
                              {materialEditButton(child)}
                              {labelPrintButton(child)}
                              <button
                                title={"解除" + child.name + "关联"}
                                onClick={() =>
                                  setModal({
                                    kind: "unlink-material",
                                    item: link,
                                  })
                                }
                              >
                                <X size={15} />
                              </button>
                            </div>
                          ),
                        },
                      };
                    })}
                    empty={
                      <Empty
                        title={
                          categories.children
                            ? "没有符合类别的物料"
                            : "暂无二级物料"
                        }
                        action={
                          !categories.children && (
                            <Button
                              small
                              onClick={() =>
                                setModal({
                                  kind: "child-create",
                                  extra: { parent_id: part.id, level: 2 },
                                })
                              }
                            >
                              <Plus size={15} />
                              新增二级物料
                            </Button>
                          )
                        }
                      />
                    }
                  />
                </>
              )}
              {tab === "parents" && part.material_level === 2 && (
                <>
                  <div className="section-toolbar">
                    <h3>关联一级物料</h3>
                    <Button
                      small
                      onClick={() =>
                        setModal({ kind: "material-parents", item: part })
                      }
                    >
                      <LinkIcon size={14} />
                      选择关联
                    </Button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>名称</th>
                          <th>编号</th>
                          <th>规格型号</th>
                          <th className="num">用量</th>
                          <th className="num">库存</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parentLinks.map((link) => {
                          const parent = findPart(link.parent_id)!;
                          return (
                            <tr key={link.id}>
                              <td>
                                <button
                                  className="text-link"
                                  onClick={() =>
                                    openMaterial(parent.id, "children")
                                  }
                                >
                                  {parent.name}
                                  <ArrowUpRight size={13} />
                                </button>
                              </td>
                              <td className="mono">{parent.code}</td>
                              <td>{parent.spec || "—"}</td>
                              <td className="num">{amount(link.qty)}</td>
                              <td className="num">{amount(parent.stock)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!parentLinks.length && <Empty title="未关联一级物料" />}
                  </div>
                </>
              )}
              {tab === "info" && (
                <div className="detail-columns">
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>物料资料</h3>
                      <Package size={18} />
                    </div>
                    <dl className="info-list">
                      <dt>物料编码</dt>
                      <dd className="mono">{part.code}</dd>
                      <dt>关联产品</dt>
                      <dd>
                        {partBomProducts.length ? (
                          <button className="text-link" onClick={() => openDetailTab("boms")}>
                            {partBomProducts.join("、")}
                            <ChevronRight size={14} />
                          </button>
                        ) : "未关联 BOM"}
                      </dd>
                      <dt>物料管理员</dt>
                      <dd>{userName(part.custodian_id)}</dd>
                      <dt>物料名称</dt>
                      <dd>{part.name}</dd>
                      <dt>外部料号</dt>
                      <dd className="mono">{part.external_code || "—"}</dd>
                      <dt>品牌</dt>
                      <dd>{part.brand || "—"}</dd>
                      <dt>规格 / 封装</dt>
                      <dd>{part.spec || "未填写"}</dd>
                      <dt>物料类别</dt>
                      <dd>{part.category}</dd>
                      <dt>计量单位</dt>
                      <dd>{part.unit}</dd>
                      <dt>级别</dt>
                      <dd>
                        {part.material_level === 1 ? "一级物料" : "二级物料"}
                      </dd>
                      {part.material_level === 2 && (
                        <>
                          <dt>关联一级物料</dt>
                          <dd>{parentsCell(part)}</dd>
                        </>
                      )}
                      <dt>备注</dt>
                      <dd>{part.notes || "暂无备注"}</dd>
                    </dl>
                  </section>
                  <div className="material-detail-aside">
                    <section className="panel">
                      <div className="panel-heading">
                        <h3>物料图片</h3>
                        <Button small onClick={() => openDetailTab("files")}><ImageIcon size={14} />图片与附件</Button>
                      </div>
                      <div className="material-detail-gallery">
                        {files("parts", part.id).filter((file) => file.kind === "image").map((file) => (
                          <button type="button" key={file.id} aria-label={"预览 " + file.name}
                            onClick={() => setModal({ kind: "preview", item: file })}>
                            <img src={fileUrl(file.id)} alt={file.name} loading="lazy" />
                          </button>
                        ))}
                      </div>
                      {!files("parts", part.id).some((file) => file.kind === "image") && <p className="muted">暂无图片</p>}
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h3>供应商与报价</h3>
                        <Button
                          small
                          onClick={() =>
                            setModal({
                              kind: "quote",
                              item: { part_id: part.id },
                            })
                          }
                        >
                          <Plus size={14} />
                          关联供应商
                        </Button>
                      </div>
                      {state.quotes
                        .filter((q) => q.part_id === part.id)
                        .map((q) => (
                          <div className="quote-row" key={q.id}>
                            <div>
                              <strong>
                                <button
                                  className="text-link"
                                  onClick={() => go("suppliers", q.supplier_id)}
                                >
                                  {findSupplier(q.supplier_id)?.name}
                                </button>
                              </strong>
                              {q.price !== null && (
                                <span>
                                  {money(q.price)} / {part.unit}
                                </span>
                              )}
                              {purchaseLink(q.url)}
                            </div>
                            {supplierLinkActions(q)}
                          </div>
                        ))}
                      {!state.quotes.some((q) => q.part_id === part.id) && (
                        <Empty title="暂无关联供应商" />
                      )}
                    </section>
                  </div>
                </div>
              )}
              {tab === "files" && fileManager("parts", part.id)}
              {tab === "boms" && (
                <>
                  {!archived && (
                    <div className="section-toolbar">
                      <h3>关联 BOM</h3>
                      <Button small onClick={() => setModal({ kind: "part", item: part })}>
                        <Pencil size={14} />
                        编辑 BOM 关联
                      </Button>
                    </div>
                  )}
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>关联产品</th>
                          <th>BOM 版本</th>
                          <th className="num">用量</th>
                          <th>位号</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partBomLines.map((l) => {
                          const v = state.bom_versions.find(
                            (v) => v.id === l.version_id,
                          );
                          if (!v) return null;
                          return (
                            <tr key={l.id}>
                              <td>
                                <button
                                  className="text-link"
                                  onClick={() => {
                                    go("products", v.product_id, { "workspace.version": v.id, "workspace.materialLevel": part.material_level });
                                  }}
                                >
                                  {findProduct(v.product_id)?.name}
                                  <ArrowUpRight size={14} />
                                </button>
                              </td>
                              <td>{v.name}</td>
                              <td className="num">
                                {amount(l.qty)} {part.unit}
                              </td>
                              <td>{l.reference || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!partBomLines.length && (
                      <Empty title="未关联 BOM" />
                    )}
                  </div>
                </>
              )}
              {tab === "purchases" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>采购单</th>
                        <th>供应商</th>
                        <th className="num">采购数量</th>
                        <th className="num">已入库</th>
                        <th className="num">待入库</th>
                        <th>日期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.purchase_lines
                        .filter((l) => l.part_id === part.id)
                        .map((l) => {
                          const po = state.purchases.find(
                            (p) => p.id === l.purchase_id,
                          )!;
                          return (
                            <tr key={l.id}>
                              <td>
                                <button
                                  className="text-link mono"
                                  onClick={() => go("purchases", po.id)}
                                >
                                  {po.code}
                                </button>
                              </td>
                              <td>{findSupplier(po.supplier_id)?.name}</td>
                              <td className="num"><QuantityHighlight value={l.qty} /></td>
                              <td className="num">{receivedQuantity(l)}</td>
                              <td className="num">
                                {pendingQuantity(l)}
                              </td>
                              <td>{po.date}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  {!state.purchase_lines.some((l) => l.part_id === part.id) && (
                    <Empty text="该物料暂无采购记录。" />
                  )}
                </div>
              )}
              {tab === "activity" && (
                <ActivityPanel key={part.id} part={part.id} />
              )}
              {tab === "history" &&
                movementTable(
                  state.movements.filter((m) => m.part_id === part.id),
                )}
              <div className="danger-footer">
                <Button
                  small
                  onClick={() => setModal({ kind: "delete-part", item: part })}
                >
                  <Trash2 size={14} />
                  删除物料
                </Button>
                <span>
                  删除后可在「已删除物料」恢复。库存和历史记录会保留。
                </span>
              </div>
            </>
          )}
          {view === "suppliers" && !detail && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    供应商{" "}
                    <span className="heading-count">
                      {state.suppliers.length}
                    </span>
                  </h1>
                </div>
                <Button primary onClick={() => setModal({ kind: "supplier" })}>
                  <Plus size={17} />
                  新建供应商
                </Button>
              </div>
              <div className="section-toolbar">
                <span className="muted">所有供应商</span>
                <div className="search-input">
                  <Search size={16} />
                  <input
                    placeholder="搜索供应商、联系人…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>供应商名称</th>
                      <th>联系人</th>
                      <th>联系方式</th>
                      <th>地址</th>
                      <th className="num">关联物料</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.suppliers
                      .filter((s) => match(s.name, s.contact, s.phone))
                      .map((s) => (
                        <tr key={s.id}>
                          <td className="strong">
                            <button
                              className="text-link"
                              onClick={() => go("suppliers", s.id)}
                            >
                              {s.name} <ArrowUpRight size={13} />
                            </button>
                            <small>{s.notes}</small>
                          </td>
                          <td>{s.contact || "—"}</td>
                          <td>
                            {s.phone || "—"}
                            <small>{s.email}</small>
                          </td>
                          <td>{s.address || "—"}</td>
                          <td className="num">
                            <button
                              className="text-link"
                              aria-label={s.name + "的关联物料"}
                              onClick={() => go("suppliers", s.id)}
                            >
                              {
                                state.quotes.filter(
                                  (q) => q.supplier_id === s.id,
                                ).length
                              }{" "}
                              种
                            </button>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                title="编辑供应商"
                                onClick={() =>
                                  setModal({ kind: "supplier", item: s })
                                }
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                title="删除供应商"
                                onClick={() =>
                                  setModal({ kind: "delete-supplier", item: s })
                                }
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!state.suppliers.filter((s) =>
                  match(s.name, s.contact, s.phone),
                ).length && (
                  <Empty
                    title="暂无供应商"
                    text="添加供应商后，即可关联报价和创建采购单。"
                  />
                )}
              </div>
            </>
          )}
          {view === "suppliers" && detail && supplier && (
            <>
              <div className="detail-heading">
                <button
                  className="back-btn"
                  aria-label="返回上一页"
                  onClick={goBack}
                >
                  <ArrowLeft size={18} />
                </button>
                <div className="detail-title">
                  <h1>{supplier.name}</h1>
                  <p>
                    {[
                      supplier.contact,
                      supplier.phone,
                      supplier.email,
                      supplier.address,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  onClick={() => setModal({ kind: "supplier", item: supplier })}
                >
                  <Pencil size={16} />
                  编辑
                </Button>
              </div>
              <div className="section-toolbar">
                <h3>
                  关联物料{" "}
                  <span className="muted">{suppliedMaterials.length}</span>
                </h3>
                <Button
                  primary
                  small
                  onClick={() =>
                    setModal({
                      kind: "quote",
                      item: { supplier_id: supplier.id },
                    })
                  }
                >
                  <Plus size={15} />
                  关联物料
                </Button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>料号</th>
                      <th>名称</th>
                      <th>规格 / 封装</th>
                      <th className="num">采购单价</th>
                      <th>采购链接</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliedMaterials.map((link) => {
                      const material = findPart(link.part_id);
                      if (!material) return null;
                      return (
                        <tr key={link.id}>
                          <td className="mono">{material.code}</td>
                          <td>
                            <button
                              className="text-link"
                              onClick={() => openMaterial(material.id)}
                            >
                              {material.name}
                              <ArrowUpRight size={13} />
                            </button>
                          </td>
                          <td>{material.spec || "—"}</td>
                          <td className="num">
                            {link.price === null
                              ? "—"
                              : money(link.price) + " / " + material.unit}
                          </td>
                          <td>{purchaseLink(link.url) || "—"}</td>
                          <td>{supplierLinkActions(link)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!suppliedMaterials.length && <Empty title="暂无关联物料" />}
              </div>
            </>
          )}
          {view === "purchases" && !detail && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    采购管理{" "}
                    <span className="heading-count">
                      {state.purchases.length}
                    </span>
                  </h1>
                </div>
                <Button primary onClick={() => setModal({ kind: "purchase" })}>
                  <Plus size={17} />
                  新建采购单
                </Button>
              </div>
              <div className="section-toolbar">
                <div className="tabs">
                  {["全部", "待入库", "部分入库", "已全部入库"].map((t) => (
                    <button
                      className={filter === t ? "selected" : ""}
                      key={t}
                      onClick={() => setFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="search-input">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索采购单号、供应商、物料…"
                  />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>采购单 / 物料</th>
                      <th>供应商</th>
                      <th className="num">采购数量</th>
                      <th className="num">已入库</th>
                      <th className="num">待入库</th>
                      <th className="num">金额</th>
                      <th>状态 / 日期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.purchases
                      .slice()
                      .reverse()
                      .filter(
                        (p) =>
                          (filter === "全部" || costStatus(p) === filter) &&
                          match(
                            p.code,
                            findSupplier(p.supplier_id)?.name,
                            state.purchase_lines
                              .filter((l) => l.purchase_id === p.id)
                              .map((l) => findPart(l.part_id)?.name)
                              .join(" "),
                          ),
                      )
                      .map((p) => {
                        const lines = state.purchase_lines.filter(
                          (l) => l.purchase_id === p.id,
                        );
                        const expanded = expandedPurchases.has(p.id);
                        return (
                          <React.Fragment key={p.id}>
                            <tr className="purchase-group">
                              <td>
                                <div className="purchase-order-number">
                                  <button type="button" className="icon-btn" aria-expanded={expanded}
                                    aria-label={(expanded ? "收起采购单 " : "展开采购单 ") + p.code}
                                    onClick={() => setExpandedPurchases((old) => {
                                      const next = new Set(old);
                                      if (next.has(p.id)) next.delete(p.id);
                                      else next.add(p.id);
                                      return next;
                                    })}>
                                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                  </button>
                                  <button className="text-link mono" onClick={() => go("purchases", p.id)}>
                                    {p.code}<ArrowUpRight size={14} />
                                  </button>
                                </div>
                              </td>
                              <td>{findSupplier(p.supplier_id)?.name}</td>
                              <td colSpan={3} className="muted">
                                {lines.length} 种物料
                              </td>
                              <td className="num strong">
                                {money(
                                  lines.reduce(
                                    (s, l) => s + l.price * l.qty,
                                    0,
                                  ),
                                )}
                              </td>
                              <td>
                                <div className="purchase-summary-actions">
                                  <OptionTag label={costStatus(p)} />
                                  {!archived && <Button type="button" small
                                    aria-label={"编辑采购单 " + p.code}
                                    onClick={() => setModal({ kind: "purchase", item: p })}>
                                    <Pencil size={13} />编辑
                                  </Button>}
                                </div>
                                <small>
                                  {p.date} · {userName(p.responsible_id)}
                                </small>
                              </td>
                            </tr>
                            {expanded && lines.map((l) => {
                              const part = findPart(l.part_id);
                              return (
                                <tr key={l.id}>
                                  <td className="indented">
                                    {purchaseMaterialLabel(l)}
                                  </td>
                                  <td className="muted">{part?.spec}</td>
                                  <td className="num">
                                    <QuantityHighlight value={l.qty} /> {part?.unit}
                                  </td>
                                  <td className="num">{receivedQuantity(l)}</td>
                                  <td className="num">
                                    {pendingQuantity(l)}
                                  </td>
                                  <td className="num">
                                    {money(l.price * l.qty)}
                                  </td>
                                  <td>
                                    {!archived && part && !part.deleted_at && (
                                        <Button
                                          small
                                          onClick={() =>
                                            startInventory("入库", part, {
                                              purchase_line_id: l.id,
                                              qty: Math.max(
                                                0,
                                                l.qty - l.received,
                                              ),
                                            })
                                          }
                                        >
                                          {l.received >= l.qty ? "补充入库" : "办理入库"}
                                          <ChevronRight size={13} />
                                        </Button>
                                      )}
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                  </tbody>
                </table>
                {!state.purchases.filter(
                  (p) =>
                    (filter === "全部" || costStatus(p) === filter) &&
                    match(
                      p.code,
                      findSupplier(p.supplier_id)?.name,
                      state.purchase_lines
                        .filter((l) => l.purchase_id === p.id)
                        .map((l) => findPart(l.part_id)?.name)
                        .join(" "),
                    ),
                ).length && (
                  <Empty
                    title="没有采购单"
                    text="创建采购单，或调整筛选条件。"
                  />
                )}
              </div>
            </>
          )}
          {view === "purchases" && detail && purchase && (
            <>
              <div className="detail-heading">
                <button className="back-btn" aria-label="返回上一页" onClick={goBack}>
                  <ArrowLeft size={18} />
                </button>
                <div className="detail-title">
                  <div className="inline">
                    <h1 className="mono">{purchase.code}</h1>
                    <OptionTag label={costStatus(purchase)} />
                  </div>
                  <p>
                    {findSupplier(purchase.supplier_id)?.name}
                    <span>·</span>
                    {purchase.date}
                    <span>·</span>
                    {purchase.notes || "无备注"}
                  </p>
                </div>
                {!archived && <Button onClick={() => setModal({ kind: "purchase", item: purchase })}>
                  <Pencil size={15} />编辑采购单
                </Button>}
                <Button
                  onClick={() =>
                    exportCSV(
                      state.purchase_lines
                        .filter((l) => l.purchase_id === purchase.id)
                        .map((l) => ({
                          物料编码: findPart(l.part_id)?.code,
                          名称: findPart(l.part_id)?.name,
                          采购数量: l.qty,
                          已入库: l.received,
                          待入库: Math.max(0, l.qty - l.received),
                          超收: Math.max(0, l.received - l.qty),
                          单价: l.price,
                        })),
                      purchase.code,
                    )
                  }
                >
                  <Download size={16} />
                  导出明细
                </Button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>物料</th>
                      <th className="num">采购数量</th>
                      <th className="num">采购单价</th>
                      <th className="num">采购金额</th>
                      <th className="num">已入库</th>
                      <th className="num">待入库</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.purchase_lines
                      .filter((l) => l.purchase_id === purchase.id)
                      .map((l) => {
                        const p = findPart(l.part_id);
                        return (
                          <tr key={l.id}>
                            <td>
                              {purchaseMaterialLabel(l)}
                            </td>
                            <td className="num">
                              <QuantityHighlight value={l.qty} /> {p?.unit}
                            </td>
                            <td className="num">{money(l.price)}</td>
                            <td className="num">{money(l.price * l.qty)}</td>
                            <td className="num">{receivedQuantity(l)}</td>
                            <td className="num">
                              {pendingQuantity(l)}
                            </td>
                            <td>
                              {p?.deleted_at ? (
                                <span className="muted">物料已删除</span>
                              ) : !archived ? (
                                <Button
                                  small
                                  onClick={() =>
                                    startInventory("入库", p, {
                                      purchase_line_id: l.id,
                                      qty: Math.max(0, l.qty - l.received),
                                    })
                                  }
                                >
                                  <ArrowDownToLine size={14} />
                                  {l.received >= l.qty ? "补充入库" : "入库"}
                                </Button>
                              ) : (
                                <span className="muted">已完成</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <h3 className="section-title">关联入库流水</h3>
              {movementTable(
                state.movements.filter((m) =>
                  state.purchase_lines.some(
                    (l) =>
                      l.purchase_id === purchase.id &&
                      l.id === m.purchase_line_id,
                  ),
                ),
              )}
            </>
          )}
          {view === "movements" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    库存流水{" "}
                    <span className="heading-count">
                      {state.movements.length}
                    </span>
                  </h1>
                </div>
                <Button primary onClick={() => startInventory("入库")}>
                  <Plus size={17} />
                  库存操作
                </Button>
              </div>
              <div className="section-toolbar">
                <div className="tabs">
                  {["全部", "入库", "出库", "退库", "报废"].map((t) => (
                    <button
                      key={t}
                      className={filter === t ? "selected" : ""}
                      onClick={() => setFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="toolbar-controls">
                  <div className="search-input">
                    <Search size={16} />
                    <input
                      placeholder="搜索物料、单号、用途…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <Button
                    small
                    onClick={() =>
                      exportCSV(
                        recentMovements(state.movements)
                          .filter(
                            (m) =>
                              (filter === "全部" || m.type === filter) &&
                              match(
                                findPart(m.part_id)?.name,
                                findPart(m.part_id)?.code,
                                m.code,
                                m.reason,
                              ),
                          )
                          .map((m) => ({
                            操作单号: m.code,
                            类型: m.type,
                            物料编码: findPart(m.part_id)?.code,
                            物料名称: findPart(m.part_id)?.name,
                            数量: m.qty,
                            结存: m.balance,
                            关联产品: findProduct(m.product_id)?.name || "",
                            原因: m.reason,
                            操作时间: datetime(m.occurred_at),
                            登记时间: datetime(m.created_at),
                          })),
                        "库存流水",
                      )
                    }
                  >
                    <Download size={15} />
                    导出
                  </Button>
                </div>
              </div>
              {movementTable(
                state.movements.filter(
                  (m) =>
                    (filter === "全部" || m.type === filter) &&
                    match(
                      findPart(m.part_id)?.name,
                      findPart(m.part_id)?.code,
                      m.code,
                      m.reason,
                    ),
                ),
              )}
            </>
          )}
          {view === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>系统设置</h1>
                </div>
              </div>
              <div className="tabs page-tabs">
                {[
                  ["profile", "个人资料"],
                  ["login-activity", "登录记录"],
                  ...(currentUser?.role === "admin"
                    ? [
                        ["users", "用户管理"],
                        ["system-activity", "系统操作记录"],
                        ["assets", "素材库"],
                        ["backup", "备份与恢复"],
                      ]
                    : []),
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={accountView === id ? "selected" : ""}
                    onClick={() => setAccountView(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {accountView === "profile" && currentUser && (
                <ProfilePanel
                  user={currentUser}
                  version={avatarVersion}
                  onSaved={async () => {
                    await updateUser();
                    setAvatarVersion((version) => version + 1);
                    notify("已保存");
                  }}
                />
              )}
              {currentUser.role === "admin" && accountView === "system-activity" && <ActivityPanel />}
              {accountView === "login-activity" && (
                <ActivityPanel key="login" kind="login" />
              )}
              {currentUser?.role === "admin" && accountView === "users" && (
                <UserAdmin
                  actorId={currentUser.id}
                  onChange={async () => {
                    await updateUser();
                  }}
                />
              )}
              {currentUser.role === "admin" && accountView === "assets" && <AssetLibrary />}
              {currentUser?.role === "admin" && accountView === "backup" && (
                <div className="settings-grid">
                  <BackupPanel onRestored={onRestore} />
                </div>
              )}
            </>
          )}
          {detail &&
            ((view === "products" && !product) ||
              (view === "parts" && !part) ||
              (view === "purchases" && !purchase) ||
              (view === "suppliers" && !supplier)) && (
              <Empty
                title="记录不存在"
                action={<Button onClick={goBack}>返回上一页</Button>}
              />
            )}
          </>}
          <footer className="main-footer">
            <span>捷程未来PLM</span>
            <span>
              <span className="connection-mark" />
              {fatal ? "连接异常" : "数据已连接"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {printMaterials && <Suspense fallback={null}>
        <MaterialLabelsDialog materials={printMaterials} close={() => setPrintMaterials(null)} />
      </Suspense>}
      {!fatal && modal && (!archived || readOnlyModal) && (
        <ChoiceContext.Provider value={archived ? null : setChoice}>
          {((["product", "part", "supplier"].includes(modal.kind) &&
            !modal.item?.id) ||
            modal.kind === "bom-create" ||
            modal.kind === "child-create") && (
            <Dialog
              title={
                modal.kind === "product"
                  ? "新建产品"
                  : modal.kind === "supplier"
                    ? "新建供应商"
                    : "新建" +
                      (modal.kind === "child-create"
                        ? "二级物料 · " +
                          (findPart(modal.extra?.parent_id)?.name || "")
                        : levelName)
              }
              onClose={() => setModal(null)}
            >
              <QuickCreateForm
                images={modal.kind !== "supplier"}
                suppliers={["part", "bom-create", "child-create"].includes(modal.kind) ? supplierOptions : undefined}
                fields={
                  modal.kind === "product"
                    ? productFields.filter((f) => f.name !== "name")
                    : modal.kind === "supplier"
                      ? supplierFields.filter((f) => f.name !== "name")
                      : partFields.filter(
                          (f) => !["name", "material_level"].includes(f.name),
                        )
                }
                initial={{
                  unit: "PCS",
                  category:
                    modal.kind === "child-create" || materialLevel === 2
                      ? "电子物料"
                      : "结构物料",
                  parent_ids: modal.extra?.parent_id
                    ? [modal.extra.parent_id]
                    : [],
                }}
                parents={
                  (modal.kind === "child-create" || materialLevel === 2) &&
                  !["product", "supplier"].includes(modal.kind)
                    ? state.parts.filter((p) => p.material_level === 1)
                    : undefined
                }
                onCancel={() => setModal(null)}
                create={async (data) => {
                  const r = await businessApi(
                    modal.kind === "bom-create"
                      ? "bom-materials"
                      : ["part", "child-create"].includes(modal.kind)
                        ? "parts"
                        : modal.kind === "product"
                          ? "products"
                          : "suppliers",
                    "POST",
                    {
                      ...data,
                      material_level:
                        modal.kind === "child-create" ? 2 : materialLevel,
                      version_id: selectedVersion?.id,
                    },
                  );
                  return r.id;
                }}
                upload={async (id, images) => {
                  await uploadProjectFiles(projectId, modal.kind === "product" ? "products" : "parts", id, images);
                }}
                done={async () => {
                  await refresh();
                  setModal(null);
                  notify("已添加");
                }}
              />
            </Dialog>
          )}
          {["material-parents", "material-children"].includes(modal.kind) && (
            <Dialog
              title={
                modal.kind === "material-parents"
                  ? "选择关联一级物料"
                  : "选择关联二级物料"
              }
              onClose={() => setModal(null)}
            >
              <RecordPicker
                create={{
                  resource: "parts",
                  level: modal.kind === "material-parents" ? 1 : 2,
                }}
                records={state.parts.filter(
                  (p) =>
                    p.material_level ===
                    (modal.kind === "material-parents" ? 1 : 2),
                )}
                selected={state.material_links
                  .filter((l) =>
                    modal.kind === "material-parents"
                      ? l.child_id === modal.item.id
                      : l.parent_id === modal.item.id,
                  )
                  .map((l) =>
                    modal.kind === "material-parents"
                      ? l.parent_id
                      : l.child_id,
                  )}
                onCancel={() => setModal(null)}
                submit={async (ids) => {
                  await mutate(
                    modal.kind + "/" + modal.item.id,
                    "PUT",
                    modal.kind === "material-parents"
                      ? { parent_ids: ids }
                      : { child_ids: ids },
                  );
                }}
              />
            </Dialog>
          )}
          {modal.kind === "unlink-material" && (
            <Dialog title="解除关联" onClose={() => setModal(null)}>
              <AsyncAction
                onCancel={() => setModal(null)}
                label="解除关联"
                action={() =>
                  mutate(
                    "material-links/" + modal.item.id,
                    "DELETE",
                    undefined,
                    "已解除关联",
                  )
                }
              />
            </Dialog>
          )}
          {modal.kind === "material-files" && (
            <Dialog
              title={modal.item.name + " · 图片与附件"}
              wide
              onClose={() => setModal(null)}
            >
              {fileManager("parts", modal.item.id)}
            </Dialog>
          )}

          {["product", "part", "supplier"].includes(modal.kind) &&
            modal.item?.id && (
              <Dialog
                title={
                  (modal.item?.id ? "编辑" : "新建") +
                  (
                    { product: "产品", part: "物料", supplier: "供应商" } as any
                  )[modal.kind]
                }
                onClose={() => setModal(null)}
              >
                <EntityForm
                  fields={
                    modal.kind === "product"
                      ? productFields
                      : modal.kind === "part"
                        ? partFields
                        : supplierFields
                  }
                  initial={modal.item}
                  suppliers={modal.kind === "part" ? {
                    options: supplierOptions,
                    linked: state.quotes.filter((quote) => quote.part_id === modal.item.id)
                      .map((quote) => quote.supplier_id),
                  } : undefined}
                  bomLinks={modal.kind === "part" ? {
                    products: state.products,
                    versions: state.bom_versions,
                    linked: state.bom_lines.filter((line) => line.part_id === modal.item.id),
                  } : undefined}
                  onCancel={() => setModal(null)}
                  images={
                    modal.kind === "product" || modal.kind === "part"
                      ? {
                          upload: async (files) => {
                            await uploadProjectFiles(projectId, modal.kind === "part" ? "parts" : "products", modal.item.id, files);
                          },
                          finish: async () => {
                            await refresh();
                            setModal(null);
                            notify("已保存");
                          },
                        }
                      : undefined
                  }
                  submit={async (data) => {
                    if (modal.kind === "product" || modal.kind === "part") {
                      await businessApi((modal.kind === "part" ? "parts/" : "products/") + data.id, "PUT", data);
                    } else {
                      await mutate("suppliers/" + data.id, "PUT", data);
                    }
                  }}
                />
              </Dialog>
            )}
          {modal.kind === "bom-line" && (
            <Dialog
              title={modal.item?.id ? "编辑 BOM 物料" : "添加 BOM 物料"}
              onClose={() => setModal(null)}
            >
              <BomForm
                parts={state.parts.filter(
                  (p) => p.material_level === materialLevel,
                )}
                item={modal.item}
                create={{
                  resource: "parts",
                  level: materialLevel,
                }}
                submit={(d) =>
                  mutate(
                    "bom-lines" + (d.id ? "/" + d.id : ""),
                    d.id ? "PUT" : "POST",
                    d,
                  )
                }
                onCancel={() => setModal(null)}
              />
            </Dialog>
          )}
          {modal.kind === "version" && (
            <Dialog title="新建 BOM 版本" onClose={() => setModal(null)}>
              <EntityForm
                fields={[
                  {
                    name: "notes",
                    label: "版本说明",
                    type: "textarea",
                    wide: true,
                  },
                ]}
                initial={{
                  product_id: product?.id,
                  copy_from: selectedVersion?.id,
                }}
                onCancel={() => setModal(null)}
                submit={async (d) => {
                  const r = await businessApi("bom-versions", "POST", d);
                  await refresh();
                  setVersion(r.id);
                  setModal(null);
                  notify("新版本已建立");
                }}
              />
            </Dialog>
          )}
          {modal.kind === "quote" && (
            <Dialog
              title={
                modal.item.id
                  ? "编辑供应商关联"
                  : modal.item.part_id
                    ? "关联供应商"
                    : "关联物料"
              }
              onClose={() => setModal(null)}
            >
              <EntityForm
                fields={[
                  ...(!modal.item.supplier_id
                    ? [
                        {
                          name: "supplier_id",
                          label: "供应商",
                          required: true,
                          options: supplierOptions.filter(
                            (s) =>
                              !state.quotes.some(
                                (q) =>
                                  q.part_id === modal.item.part_id &&
                                  q.supplier_id === s.value,
                              ),
                          ),
                          create: { resource: "suppliers" as const },
                          wide: true,
                        },
                      ]
                    : []),
                  ...(!modal.item.part_id
                    ? [
                        {
                          name: "part_id",
                          label: "物料",
                          required: true,
                          options: partOptions.filter(
                            (p) =>
                              !state.quotes.some(
                                (q) =>
                                  q.supplier_id === modal.item.supplier_id &&
                                  q.part_id === p.value,
                              ),
                          ),
                          create: { resource: "parts" as const },
                          wide: true,
                        },
                      ]
                    : []),
                  {
                    name: "price",
                    label: "采购单价（元）",
                    type: "number",
                    wide: true,
                  },
                  {
                    name: "url",
                    label: "采购链接",
                    type: "url",
                    wide: true,
                    placeholder: "https://…",
                  },
                ]}
                initial={modal.item}
                onCancel={() => setModal(null)}
                submit={(d) => mutate("quotes", "POST", d)}
              />
            </Dialog>
          )}
          {inventoryPart && (
            <Dialog title="库存详情" onClose={() => setModal(null)} wide>
              <div className="stock-hint">
                <MaterialThumbnail imageId={files("parts", inventoryPart.id).find((file) => file.kind === "image")?.id}
                  alt={inventoryPart.name + "物料图片"} className="stock-material-photo" />
                <div className="stock-material-info">
                  <strong>{inventoryPart.name}</strong>
                  <small className="mono">{inventoryPart.code}</small>
                </div>
              </div>
              <dl className="info-list inventory-detail-info">
                <dt>当前库存</dt><dd><InventoryQuantity part={inventoryPart} /> {inventoryPart.unit}</dd>
                <dt>规格 / 封装</dt><dd>{inventoryPart.spec || "—"}</dd>
                <dt>最低库存</dt><dd>{amount(inventoryPart.min_stock)} {inventoryPart.unit}</dd>
                <dt>仓库位置</dt><dd>{materialCell(inventoryPart, "location", "仓库位置")}</dd>
              </dl>
              {!archived && <div className="inventory-detail-actions">{inventoryRowActions(inventoryPart, true)}</div>}
              <h3>库存流水</h3>
              {movementTable(state.movements.filter((row) => row.part_id === inventoryPart.id), 10)}
            </Dialog>
          )}
          {modal.kind === "movement" && (
            <Dialog title={modal.item.id ? "编辑库存流水" : "库存操作"} onClose={() => setModal(null)} wide>
              <MovementForm
                state={state}
                initial={modal.item}
                onCancel={() => setModal(null)}
                submit={(d) => modal.item.id
                  ? mutate("movements/" + modal.item.id, "PUT", d, "库存流水已更新")
                  : mutate("movements", "POST", d, "库存已更新，流水已记录")}
                remove={modal.item.id ? () =>
                  mutate("movements/" + modal.item.id, "DELETE", { expected: modal.item }, "库存流水已删除")
                  : undefined}
              />
            </Dialog>
          )}
          {modal.kind === "purchase" && (
            <Dialog title={modal.item?.id ? "编辑采购单" : "新建采购单"} wide onClose={() => setModal(null)}>
              <PurchaseForm
                state={state}
                initial={modal.item}
                defaultOwner={currentUser?.id || ""}
                onCancel={() => setModal(null)}
                submit={(d) => modal.item?.id
                  ? mutate("purchases/" + modal.item.id, "PUT", d, "采购单已更新")
                  : mutate("purchases", "POST", d, "采购单已创建")}
                remove={modal.item?.id ? async (expected) => {
                  await mutate("purchases/" + modal.item.id, "DELETE", { expected }, "采购单已删除");
                  if (detail === modal.item.id) go("purchases");
                } : undefined}
              />
            </Dialog>
          )}
          {modal.kind === "electronic-import" && (
            <Dialog
              title="导入电子物料 BOM"
              wide
              onClose={() => setModal(null)}
            >
              <ElectronicImportForm
                state={state}
                context={modal.extra || {}}
                onCancel={() => setModal(null)}
                submit={async (payload) => {
                  const result = await businessApi(
                    "electronic-import/commit",
                    "POST",
                    payload,
                  );
                  await refresh();
                  setModal(null);
                  notify(
                    "已导入 " +
                      result.materials +
                      " 项物料（新建 " +
                      result.created +
                      "，复用 " +
                      result.reused +
                      "）",
                  );
                }}
              />
            </Dialog>
          )}
          {modal.kind === "import" && (
            <Dialog title="导入 BOM" onClose={() => setModal(null)}>
              <ImportForm
                onCancel={() => setModal(null)}
                submit={async (rows) => {
                  const result = await businessApi(
                    "bom-import",
                    "POST",
                    { version_id: selectedVersion?.id, material_level: materialLevel, rows },
                  );
                  await refresh();
                  setModal(null);
                  notify(`已导入 ${result.count} 行，新建 ${result.created} 项，复用 ${result.reused} 行`);
                }}
              />
            </Dialog>
          )}
          {modal.kind === "qr" && (
            <Dialog title="物料二维码" onClose={() => setModal(null)}>
              <QRPanel part={modal.item} />
            </Dialog>
          )}
          {modal.kind === "scan" && (
            <Dialog title="扫码识别物料" onClose={() => setModal(null)}>
              <Scanner
                aliases={state.material_code_aliases}
                parts={state.parts}
                onFound={(p) => {
                  setModal(null);
                  go("parts", p.id);
                }}
              />
            </Dialog>
          )}
          {modal.kind === "preview" && (
            <Dialog title={modal.item.name} wide onClose={() => setModal(null)}>
              <div className="image-preview">
                <img src={fileUrl(modal.item.id)} alt={modal.item.name} />
              </div>
              <div className="dialog-actions">
                <a
                  className="btn"
                  href={fileUrl(modal.item.id)}
                  download={modal.item.name}
                >
                  <Download size={15} />
                  下载图片
                </a>
              </div>
            </Dialog>
          )}
          {modal.kind === "deleted-parts" && (
            <Dialog title="已删除物料" onClose={() => setModal(null)}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>料号</th>
                      <th>名称</th>
                      <th>库存</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.deleted_parts.map((material) => (
                      <tr key={material.id}>
                        <td className="mono">{material.code}</td>
                        <td>
                          <button
                            className="text-link"
                            onClick={() => {
                              setModal(null);
                              openMaterial(material.id);
                            }}
                          >
                            {material.name}
                          </button>
                        </td>
                        <td>
                          {amount(material.stock)} {material.unit}
                        </td>
                        <td>
                          <Button
                            small
                            onClick={() =>
                              setModal({ kind: "restore-part", item: material })
                            }
                          >
                            恢复
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Dialog>
          )}
          {modal.kind === "restore-part" && (
            <Dialog title="恢复物料" onClose={() => setModal(null)}>
              <p className="confirm-copy">
                恢复「{modal.item.name}」到物料库。
              </p>
              <AsyncAction
                label="确认恢复"
                onCancel={() => setModal(null)}
                action={() =>
                  mutate(
                    "deleted-parts/" + modal.item.id,
                    "PUT",
                    {},
                    "物料已恢复",
                  )
                }
              />
            </Dialog>
          )}
          {modal.kind === "delete-product" && (
            <Dialog title="删除产品" onClose={() => setModal(null)}>
              <p className="confirm-copy">
                确定删除「{modal.item.name}」？该产品的
                BOM、图片和附件将一并删除。物料库记录和料号会保留。
              </p>
              <EntityForm
                fields={[
                  {
                    name: "password",
                    label: "当前管理员密码",
                    type: "password",
                    required: true,
                    wide: true,
                  },
                ]}
                label="确认删除"
                onCancel={() => setModal(null)}
                submit={async ({ password }) => {
                  await mutate(
                    "products/" + modal.item.id,
                    "DELETE",
                    { delete_bom: true, password },
                    "已删除",
                  );
                  go("products");
                }}
              />
            </Dialog>
          )}
          {modal.kind.startsWith("delete-") &&
            modal.kind !== "delete-product" && (
              <Dialog title="确认删除" onClose={() => setModal(null)}>
                <p className="confirm-copy">
                  {modal.kind === "delete-part"
                    ? `删除「${modal.item.name}」？物料将从常用列表移除，可在「已删除物料」恢复。库存和原有记录会保留。`
                    : modal.kind === "delete-line"
                      ? "将从当前 BOM 版本移除此物料，其他版本不会受影响。"
                      : modal.kind === "delete-quote"
                        ? "将解除此物料与供应商的关联。"
                        : modal.kind === "delete-file"
                          ? "将删除该图片或附件。"
                          : "确定删除「" +
                            modal.item.name +
                            "」？已有业务关联的记录将无法删除。"}
                </p>
                <AsyncAction
                  onCancel={() => setModal(null)}
                  label="确认删除"
                  action={async () => {
                    const map: any = {
                      "delete-line": "bom-lines",
                      "delete-part": "parts",
                      "delete-supplier": "suppliers",
                      "delete-file": "files",
                      "delete-quote": "quotes",
                    };
                    await mutate(
                      map[modal.kind] + "/" + modal.item.id,
                      "DELETE",
                      undefined,
                      "已删除",
                    );
                    if (modal.kind === "delete-part") go("parts");
                  }}
                />
              </Dialog>
            )}
          {modal.kind === "demo" && (
            <Dialog title="载入示例工作空间" onClose={() => setModal(null)}>
              <p className="confirm-copy">
                将创建 4 个示例产品、8 种物料、2 家供应商，以及示例
                BOM、采购和库存流水。示例数据会保存到当前项目，请在正式录入数据前体验。
              </p>
              <AsyncAction
                onCancel={() => setModal(null)}
                label="载入示例"
                action={() => mutate("demo", "POST", {}, "示例数据已载入")}
              />
            </Dialog>
          )}
        </ChoiceContext.Provider>
      )}
      {!fatal && !archived && choice && (
        <Dialog
          title={"新建" + choiceNames[choice.resource]}
          onClose={() => setChoice(null)}
        >
          <QuickCreateForm
            images={choice.resource !== "suppliers"}
            suppliers={choice.resource === "parts" ? supplierOptions : undefined}
            fields={(choice.resource === "parts"
              ? partFields
              : choice.resource === "products"
                ? productFields
                : supplierFields
            ).filter(
              (field) =>
                field.name !== "name" &&
                (field.name !== "material_level" || !choice.level),
            )}
            initial={{
              unit: "PCS",
              material_level: choice.level || 1,
              category: choice.level === 2 ? "电子物料" : "结构物料",
            }}
            create={async (data) =>
              (await businessApi(choice.resource, "POST", data)).id
            }
            upload={async (id, images) => {
              await uploadProjectFiles(projectId, choice.resource, id, images);
            }}
            done={async (id) => {
              const updated = await refresh();
              choice.select(id, updated);
              setChoice(null);
              notify("已添加");
            }}
            onCancel={() => setChoice(null)}
          />
        </Dialog>
      )}
    </div>
    </ProjectContext.Provider>
  );
}
function AsyncAction({
  action,
  onCancel,
  label,
}: {
  action: () => Promise<any>;
  onCancel: () => void;
  label: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      {error && <div className="form-error">{error}</div>}
      <div className="dialog-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button
          primary
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await action();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={16} className="spin" />}
          {label}
        </Button>
      </div>
    </>
  );
}
function BomForm({
  parts,
  item,
  create,
  submit,
  onCancel,
}: {
  parts: Part[];
  item: any;
  create: CreateChoice;
  submit: (d: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const matchedIds = new Set(
    parts
      .filter((p) =>
        [p.code, p.name, p.spec].join(" ").toLowerCase().includes(query),
      )
      .map((p) => p.id),
  );
  return (
    <>
      <div className="search-input form-search">
        <Search size={16} />
        <input
          aria-label="搜索可选物料"
          placeholder="搜索物料"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <EntityForm
        initial={item}
        fields={[
          {
            name: "part_id",
            label: "选择物料",
            create,
            required: true,
            wide: true,
            optionFilter: (id) => matchedIds.has(id),
            options: parts.map((p) => ({
              value: p.id,
              label: p.code + " · " + p.name + " / " + p.spec,
            })),
          },
          {
            name: "qty",
            label: "单套用量",
            type: "number",
            min: 0.000001,
            required: true,
          },
          {
            name: "reference",
            label: "位号（可选）",
            placeholder: "例如 R1、R2",
          },
          { name: "notes", label: "行备注", type: "textarea", wide: true },
        ]}
        submit={submit}
        onCancel={onCancel}
      />
    </>
  );
}
function useRecordRemoval(remove?: () => Promise<void>) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return {
    available: !!remove, confirming, pending, error,
    toggle(next: boolean) { setError(""); setConfirming(next); },
    async confirm() {
      if (!remove || pending) return;
      setPending(true);
      setError("");
      try { await remove(); }
      catch (e) { setError((e as Error).message); }
      finally { setPending(false); }
    },
  };
}

function RecordFormActions({ removal, busy, onCancel, saveLabel, deleteLabel, confirmText, canSave = true }: {
  removal: ReturnType<typeof useRecordRemoval>;
  busy: boolean;
  onCancel: () => void;
  saveLabel: string;
  deleteLabel: string;
  confirmText: string;
  canSave?: boolean;
}) {
  return <>
    {removal.confirming && <p className="confirm-copy">{confirmText}</p>}
    <div className="dialog-actions">
      {removal.available && !removal.confirming && <Button type="button" className="record-delete" disabled={busy}
        onClick={() => removal.toggle(true)}><Trash2 size={15} />{deleteLabel}</Button>}
      <Button type="button" disabled={busy || removal.pending}
        onClick={removal.confirming ? () => removal.toggle(false) : onCancel}>取消</Button>
      {removal.confirming
        ? <Button type="button" className="record-delete-confirm" disabled={removal.pending}
          onClick={() => void removal.confirm()}>确认删除</Button>
        : <Button primary type="submit" disabled={busy || !canSave}>
          {busy && <Loader2 size={16} className="spin" />}{saveLabel}
        </Button>}
    </div>
  </>;
}

function MovementForm({
  state,
  initial,
  submit,
  onCancel,
  remove,
}: {
  state: State;
  initial: Partial<Movement>;
  submit: (d: any) => Promise<void>;
  onCancel: () => void;
  remove?: () => Promise<void>;
}) {
  const [type, setType] = useState(initial.type || "入库");
  const [part, setPart] = useState(initial.part_id || "");
  const [source, setSource] = useState(initial.purchase_line_id || "");
  const [original, setOriginal] = useState(initial.original_id || "");
  const [qty, setQty] = useState(String(initial.qty || ""));
  const [product, setProduct] = useState(initial.product_id || "");
  const [initialTimestamp] = useState(() => initial.occurred_at || initial.created_at || new Date().toISOString());
  const initialTime = localDateTime(initialTimestamp);
  const [operationTime, setOperationTime] = useState(initialTime);
  const [handler, setHandler] = useState(initial.handler_id || "");
  const [reason, setReason] = useState(initial.reason || "");
  const removal = useRecordRemoval(remove);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const p = state.parts.find((p) => p.id === part);
  const photos = React.useMemo(() => firstMaterialPhotos(state.files), [state.files]);
  const timestamp = new Date(operationTime === initialTime ? initialTimestamp : operationTime);
  const originals = state.movements
    .filter((m) => m.type === "出库" && m.part_id === part && new Date(m.occurred_at) <= timestamp)
    .map((m) => ({
      ...m,
      remaining:
        Math.round(
          (m.qty -
            state.movements
              .filter((r) => r.original_id === m.id && r.id !== initial.id)
              .reduce((s, r) => s + r.qty, 0)) *
            1e6,
        ) / 1e6,
    }))
    .filter((m) => m.remaining > 0);
  const sources = state.purchase_lines.filter((line) => line.part_id === part);
  const handlers = [...state.users, ...state.former_users.filter((user) => user.id === initial.handler_id)];
  function choosePart(id: string) {
    setPart(id);
    setSource("");
    setOriginal("");
    setQty("");
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || removal.confirming) return;
        setBusy(true);
        setError("");
        try {
          await submit({
            ...(initial.id ? { expected: initial } : {}),
            type,
            part_id: part,
            qty,
            product_id: type === "出库" ? product : null,
            purchase_line_id: type === "入库" ? source : null,
            original_id: type === "退库" ? original : null,
            reason,
            handler_id: handler,
            occurred_at: initial.id && operationTime === initialTime ? undefined : timestamp.toISOString(),
          });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="operation-switch">
        {["入库", "出库", "退库", "报废"].map((t) => (
          <button
            type="button"
            className={type === t ? "selected" : ""}
            key={t}
            onClick={() => {
              setType(t);
              setQty("");
              setSource("");
              setOriginal("");
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <MaterialPicker
        state={state}
        photos={photos}
        selected={new Set(part ? [part] : [])}
        onToggle={(id) => choosePart(id === part ? "" : id)}
        onAdd={type === "入库" ? choosePart : undefined}
        forStock
      />
      <div className="form-grid movement-fields">
        <PersonSelect users={handlers} label="经办人" value={handler} onChange={setHandler} />
        <label>
          操作时间 *
          <input type="datetime-local" required step={1} value={operationTime}
            onChange={(event) => setOperationTime(event.target.value)} />
        </label>
        {p && (
          <div className="stock-hint wide-field">
            <MaterialThumbnail imageId={photos.get(p.id)} alt={p.name + "物料图片"} className="stock-material-photo" />
            <div className="stock-material-info">
              <strong>{p.name}</strong>
              <small>{p.code} · 当前库存 {amount(p.stock)} {p.unit}</small>
              {p.spec && <small>{p.spec}</small>}
              {p.location && <small>仓库位置 {p.location}</small>}
            </div>
          </div>
        )}
        <label>
          本次{type}数量 *
          <input
            required
            type="number"
            min="0.000001"
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={p ? "单位：" + p.unit : "请输入数量"}
          />
        </label>
        {type === "出库" && (
          <label>
            关联研发产品
            <ChoiceSelect
              create={{ resource: "products" }}
              value={product}
              onValueChange={setProduct}
            >
              <option value="">不关联产品</option>
              {state.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </ChoiceSelect>
          </label>
        )}
        {type === "入库" && (
          <label>
            关联采购明细
            <select
              aria-label="关联采购明细"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                const l = sources.find((l) => l.id === e.target.value);
                if (l) {
                  const remaining = Math.max(0, l.qty - l.received);
                  setQty(remaining ? String(remaining) : "");
                }
              }}
            >
              <option value="">独立入库</option>
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {state.purchases.find((p) => p.id === l.purchase_id)?.code} ·
                  已入 {amount(l.received)} / 采购 {amount(l.qty)}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "退库" && (
          <label className="wide-field">
            原出库记录 *
            <select
              aria-label="原出库记录"
              required
              value={original}
              onChange={(e) => setOriginal(e.target.value)}
            >
              <option value="">请选择原出库记录</option>
              {originals.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} · {datetime(m.occurred_at)} · 可退 {amount(m.remaining)} {p?.unit} ·{" "}
                  {m.reason || "研发领料"}
                </option>
              ))}
            </select>
            {!originals.length && (
              <small className="muted">该物料没有可退回的出库数量。</small>
            )}
          </label>
        )}
        <label className="wide-field">
          {type === "报废" ? "报废原因 *" : "用途 / 备注"}
          <textarea
            rows={3}
            required={type === "报废"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              type === "报废"
                ? "请填写损坏、失效等具体原因"
                : "可填写研发用途、到货批次等信息"
            }
          />
        </label>
      </div>
      {(removal.error || error) && (
        <div className="form-error">
          <AlertCircle size={16} />
          {removal.error || error}
        </div>
      )}
      <RecordFormActions removal={removal} busy={busy} onCancel={onCancel}
        canSave={!!part} saveLabel={initial.id ? "保存修改" : "确认" + type} deleteLabel="删除流水"
        confirmText={`删除流水 ${initial.code}？库存和采购入库数量将重新计算。`} />
    </form>
  );
}
const MATERIAL_PICKER_PAGE_SIZE = 40;

function firstMaterialPhotos(files: FileRecord[]) {
  const photos = new Map<string, string>();
  for (const file of files) {
    if (file.owner_type === "parts" && file.kind === "image" && !photos.has(file.owner_id))
      photos.set(file.owner_id, file.id);
  }
  return photos;
}

function QuantityHighlight({ value, tone = "blue", prefix = "", title }: {
  value: number; tone?: OptionTone; prefix?: string; title?: string;
}) {
  return <strong className={"option-tag quantity-highlight " + tone} title={title}>{prefix}{amount(value)}</strong>;
}

function InventoryQuantity({ part }: { part: Part }) {
  const status = part.stock === 0 ? "无库存" : part.stock < part.min_stock ? "低库存" : "库存";
  const tone = status === "无库存" ? "rose" : status === "低库存" ? "amber" : "blue";
  return <QuantityHighlight value={part.stock} tone={tone} title={status} />;
}

function MaterialThumbnail({ imageId, alt = "", className }: { imageId?: string; alt?: string; className: string }) {
  const [failedImage, setFailedImage] = useState<string>();
  return (
    <span className={"thumb " + className}>
      {imageId && imageId !== failedImage ? (
        <img src={fileUrl(imageId)} alt={alt} loading="lazy" onError={() => setFailedImage(imageId)} />
      ) : (
        <Package size={17} strokeWidth={1.4} aria-hidden="true" />
      )}
    </span>
  );
}

function MaterialPicker({
  state,
  photos,
  quotesByPart,
  selected,
  onToggle,
  onAdd,
  forStock = false,
}: {
  state: State;
  photos: Map<string, string>;
  quotesByPart?: Map<string, Map<string, Quote>>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onAdd?: (id: string) => void;
  forStock?: boolean;
}) {
  const openChoice = useContext(ChoiceContext);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [product, setProduct] = useState("");
  const [page, setPage] = useState(0);
  const productById = new Map(state.products.map((item) => [item.id, item]));
  const bomProductsByPart = React.useMemo(() => {
    const productByVersion = new Map(state.bom_versions.map((item) => [item.id, item.product_id]));
    const byPart = new Map<string, Set<string>>();
    for (const line of state.bom_lines) {
      const productId = productByVersion.get(line.version_id);
      if (!productId) continue;
      const products = byPart.get(line.part_id) || new Set<string>();
      products.add(productId);
      byPart.set(line.part_id, products);
    }
    return byPart;
  }, [state.bom_versions, state.bom_lines]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = state.parts.filter((part) => {
    if (category && part.category !== category) return false;
    if (level && part.material_level !== Number(level)) return false;
    const products = bomProductsByPart.get(part.id);
    if (product === "unlinked" ? !!products : product && !products?.has(product)) return false;
    const searchText = [part.code, part.name, part.spec, part.external_code, part.brand]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchText.includes(term));
  });
  const lastPage = Math.max(0, Math.ceil(matches.length / MATERIAL_PICKER_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * MATERIAL_PICKER_PAGE_SIZE;
  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(0);
  };

  return (
    <section aria-label={forStock ? "选择库存物料" : "选择采购物料"}>
      <div className="purchase-picker-toolbar">
        <div className="search-input">
          <Search size={15} />
          <input
            type="search"
            aria-label={forStock ? "搜索库存物料" : "搜索采购物料"}
            placeholder="搜索料号、名称、规格、外部料号…"
            value={query}
            onChange={(event) => updateFilter(setQuery, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </div>
        {openChoice && onAdd && (
          <Button
            small
            type="button"
            onClick={() =>
              openChoice({
                resource: "parts",
                level: level ? Number(level) : undefined,
                select: onAdd,
              })
            }
          >
            <Plus size={15} />
            新建物料
          </Button>
        )}
      </div>
      <div className="purchase-picker-filters">
        <select
          aria-label="物料类别"
          value={category}
          onChange={(event) => updateFilter(setCategory, event.target.value)}
        >
          <option value="">全部类别</option>
          {state.material_categories.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select
          aria-label="物料级别"
          value={level}
          onChange={(event) => updateFilter(setLevel, event.target.value)}
        >
          <option value="">全部级别</option>
          <option value="1">一级物料</option>
          <option value="2">二级物料</option>
        </select>
        <select
          aria-label="关联产品"
          value={product}
          onChange={(event) => updateFilter(setProduct, event.target.value)}
        >
          <option value="">全部产品</option>
          <option value="unlinked">未关联 BOM</option>
          {state.products.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.english_code || item.code}
            </option>
          ))}
        </select>
      </div>
      <div className="purchase-picker-results" key={JSON.stringify([query, category, level, product, currentPage])}>
        {matches.slice(start, start + MATERIAL_PICKER_PAGE_SIZE).map((part) => {
          const checked = selected.has(part.id);
          const products = Array.from(bomProductsByPart.get(part.id) || [],
            (id) => productById.get(id)?.name).filter(Boolean);
          return (
            <button
              type="button"
              className="purchase-picker-row"
              aria-pressed={checked}
              key={part.id}
              onClick={() => onToggle(part.id)}
            >
              <MaterialThumbnail imageId={photos.get(part.id)} className="purchase-material-photo" />
              <span className="purchase-material-name">
                <strong>{part.name}</strong>
                <small>{[part.code, part.spec, part.external_code].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="purchase-material-meta">
                <OptionTag label={part.category} tone={materialCategoryTone(part.category, state.material_categories)} />
                <small>
                  {forStock ? "库存 " + amount(part.stock) + " " + part.unit +
                    (part.location ? " · " + part.location : "") :
                    (products.join("、") || "未关联 BOM") + (!quotesByPart?.get(part.id)?.size ? " · 未关联供应商" : "")}
                </small>
              </span>
              {checked ? <Check size={16} /> : <Plus size={16} />}
            </button>
          );
        })}
        {!matches.length && <p className="no-options">没有符合条件的物料</p>}
      </div>
      <div className="purchase-picker-footer">
        <span aria-live="polite">共 {matches.length} 项 · 已选 {selected.size} 项</span>
        {lastPage > 0 && (
          <div className="purchase-picker-pages">
            <Button small type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              上一页
            </Button>
            <span>{currentPage + 1} / {lastPage + 1}</span>
            <Button small type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
              下一页
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

type PurchaseDraftLine = {
  partId: string;
  qty: string;
  priceOverride?: { supplierId: string; value: string };
};
type PurchaseSnapshot = Pick<Purchase, "supplier_id" | "date" | "notes" | "responsible_id"> & {
  lines: Pick<PurchaseLine, "part_id" | "qty" | "price">[];
};

function PurchaseForm({
  state,
  initial,
  defaultOwner,
  submit,
  onCancel,
  remove,
}: {
  state: State;
  initial?: Purchase;
  defaultOwner: string;
  submit: (d: any) => Promise<void>;
  onCancel: () => void;
  remove?: (expected: PurchaseSnapshot) => Promise<void>;
}) {
  const existingLines = state.purchase_lines.filter((line) => line.purchase_id === initial?.id);
  const [expected] = useState<PurchaseSnapshot | undefined>(() => initial && ({
    supplier_id: initial.supplier_id, date: initial.date, notes: initial.notes, responsible_id: initial.responsible_id,
    lines: existingLines.map(({ part_id, qty, price }) => ({ part_id, qty, price })),
  }));
  const [owner, setOwner] = useState(initial?.responsible_id || defaultOwner);
  const [preferredSupplier, setPreferredSupplier] = useState(initial?.supplier_id || "");
  const [date, setDate] = useState(() => {
    if (initial) return initial.date;
    const today = new Date();
    return [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
  });
  const [notes, setNotes] = useState(initial?.notes || "");
  const [lines, setLines] = useState<PurchaseDraftLine[]>(() => initial
    ? existingLines.map((line) => ({
      partId: line.part_id, qty: String(line.qty),
      priceOverride: { supplierId: initial.supplier_id, value: String(line.price) },
    }))
    : []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const removal = useRecordRemoval(remove && expected ? () => remove(expected) : undefined);
  const receivedByPart = new Map(existingLines.map((line) => [line.part_id, line.received]));
  const supplierLocked = existingLines.some((line) => line.received > 0);
  const owners = [...state.users, ...state.former_users.filter((user) => user.id === initial?.responsible_id)];
  const { partsById, photos, quotesByPart } = React.useMemo(() => {
    const partsById = new Map([...state.parts, ...state.deleted_parts].map((part) => [part.id, part]));
    const photos = firstMaterialPhotos(state.files);
    const quotesByPart = new Map<string, Map<string, Quote>>();
    for (const quote of state.quotes) {
      if (!quotesByPart.has(quote.part_id)) quotesByPart.set(quote.part_id, new Map());
      quotesByPart.get(quote.part_id)?.set(quote.supplier_id, quote);
    }
    return { partsById, photos, quotesByPart };
  }, [state.parts, state.deleted_parts, state.files, state.quotes]);
  const selected = new Set(lines.map((line) => line.partId));
  const suppliersById = new Map(state.suppliers.map((supplier) => [supplier.id, supplier]));
  const firstQuotes = lines.length ? quotesByPart.get(lines[0].partId) : undefined;
  const commonSuppliers = Array.from(firstQuotes?.keys() || []).filter(
    (id) =>
      suppliersById.has(id) &&
      lines.every((line) => quotesByPart.get(line.partId)?.has(id)),
  );
  const supplierId = suppliersById.has(preferredSupplier)
    ? preferredSupplier
    : commonSuppliers[0] || "";
  const otherSuppliers = state.suppliers.filter((supplier) => !commonSuppliers.includes(supplier.id));
  const pricedLines = lines.map(({ partId, qty, priceOverride }) => {
    const part = partsById.get(partId);
    const quote = quotesByPart.get(partId)?.get(supplierId);
    const price = priceOverride && (!priceOverride.supplierId || priceOverride.supplierId === supplierId)
      ? priceOverride.value
      : quote?.price ?? part?.price ?? 0;
    return { part_id: partId, qty, price };
  });
  const total = pricedLines.reduce((sum, line) => sum + Number(line.qty) * Number(line.price), 0);
  const addPart = (partId: string) => setLines((current) =>
    current.some((line) => line.partId === partId)
      ? current
      : [...current, { partId, qty: "1" }],
  );
  const removePart = (partId: string) => {
    if (!receivedByPart.get(partId)) setLines((current) => current.filter((line) => line.partId !== partId));
  };
  const updateLine = (partId: string, fields: Partial<PurchaseDraftLine>) =>
    setLines((current) => current.map((line) =>
      line.partId === partId ? { ...line, ...fields } : line,
    ));
  const newLinks = supplierId ? lines.filter((line) => !quotesByPart.get(line.partId)?.has(supplierId)).length : 0;

  return (
    <form
      className="purchase-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!supplierId || !pricedLines.length || busy || removal.confirming) return;
        setError("");
        setBusy(true);
        try {
          await submit({
            supplier_id: supplierId,
            responsible_id: owner,
            date,
            notes,
            lines: pricedLines,
            expected,
          });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <MaterialPicker
        state={state}
        photos={photos}
        quotesByPart={quotesByPart}
        selected={selected}
        onToggle={(id) => selected.has(id) ? removePart(id) : addPart(id)}
        onAdd={addPart}
      />
      {!!lines.length && (
        <section aria-label="已选物料" className="purchase-form-lines">
          <div className="purchase-line-header">
            <strong>已选物料</strong>
            <span>数量</span>
            <span>单价（元）</span>
          </div>
          {lines.map((line, index) => {
            const part = partsById.get(line.partId);
            if (!part) return null;
            const received = receivedByPart.get(part.id) || 0;
            return (
              <div className="purchase-form-line" key={line.partId}>
                <div className="purchase-selected-material">
                  <MaterialThumbnail imageId={photos.get(part.id)} className="purchase-material-photo" />
                  <span className="purchase-material-name">
                    <strong>{part.name}</strong>
                    <small>
                      {part.code} · {part.unit}
                      {received > 0 && " · 已入库 " + amount(received)}
                      {!quotesByPart.get(part.id)?.size && " · 未关联供应商"}
                    </small>
                  </span>
                </div>
                <input
                  aria-label={part.name + " 数量"}
                  type="number"
                  required
                  min="0.000001"
                  step="any"
                  value={line.qty}
                  onChange={(event) => updateLine(part.id, { qty: event.target.value })}
                />
                <input
                  aria-label={part.name + " 单价"}
                  type="number"
                  required
                  min="0"
                  step="any"
                  value={pricedLines[index].price}
                  onChange={(event) =>
                    updateLine(part.id, {
                      priceOverride: { supplierId, value: event.target.value },
                    })
                  }
                />
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={"移除" + part.name}
                  disabled={received > 0}
                  onClick={() => removePart(part.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
          <div className="purchase-total">
            采购总额 <strong>{money(total)}</strong>
          </div>
        </section>
      )}
      <div className="form-grid purchase-order-fields">
        <label className="purchase-supplier-field">
          供应商 *
          <ChoiceSelect
            aria-label="供应商"
            create={supplierLocked ? undefined : { resource: "suppliers" }}
            required
            disabled={busy || supplierLocked}
            value={supplierId}
            onValueChange={(id) => {
              setPreferredSupplier(id);
              if (id && !supplierId) {
                setLines((current) => current.map((line) => line.priceOverride?.supplierId === ""
                  ? { ...line, priceOverride: { ...line.priceOverride, supplierId: id } }
                  : line));
              }
            }}
          >
            <option value="">请选择供应商</option>
            {!!commonSuppliers.length && (
              <optgroup label="已关联所选物料">
                {commonSuppliers.map((id) => (
                  <option key={id} value={id}>{suppliersById.get(id)?.name}</option>
                ))}
              </optgroup>
            )}
            {!!otherSuppliers.length && (
              <optgroup label={commonSuppliers.length ? "其他供应商" : "项目供应商"}>
                {otherSuppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </optgroup>
            )}
          </ChoiceSelect>
          {newLinks > 0 && (
            <small className="purchase-supplier-hint" role="status">
              保存后将关联 {newLinks} 项物料
            </small>
          )}
          {supplierLocked && <small className="purchase-supplier-hint">已入库，供应商已锁定</small>}
        </label>
        <PersonSelect
          users={owners}
          label="采购负责人"
          value={owner}
          onChange={setOwner}
        />
        <label>
          采购日期 *
          <input
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </div>
      <label className="form-label">
        采购备注
        <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {(removal.error || error) && <div className="form-error" role="alert">{removal.error || error}</div>}
      <RecordFormActions removal={removal} busy={busy} onCancel={onCancel} canSave={!!supplierId && !!pricedLines.length}
        saveLabel={initial ? "保存修改" : "创建采购单"} deleteLabel="删除采购单"
        confirmText={`删除采购单 ${initial?.code}？`} />
    </form>
  );
}
function ImportForm({
  submit,
  onCancel,
}: {
  submit: (rows: any[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="import-guide">
        <p>
          填写<code>数量</code>，并提供<code>物料编码</code>或<code>物料名称</code>。
        </p>
        <p>
          已有料号直接复用。找不到料号时，按名称新建物料并自动生成料号。
        </p>
        <Button
          small
          onClick={() =>
            exportCSV(
              [
                {
                  物料编码: "",
                  物料名称: "示例物料",
                  类别: "",
                  规格型号: "",
                  数量: 1,
                  单位: "PCS",
                  参考单价: "",
                  位号: "",
                  备注: "",
                },
              ],
              "BOM导入模板",
            )
          }
        >
          <Download size={15} />
          下载 CSV 模板
        </Button>
      </div>
      <label className="upload-zone">
        <Upload size={24} />
        <strong>{filename || "选择 CSV 文件"}</strong>
        <span>UTF-8 编码 · 最多 5,000 行</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            setError("");
            setRows([]);
            const f = e.target.files?.[0];
            if (!f) return;
            setFilename(f.name);
            Papa.parse<Record<string, string>>(await f.text(), {
              header: true,
              skipEmptyLines: "greedy",
              transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
              complete: (r) => {
                if (r.errors.length) {
                  setError("CSV 解析失败：" + r.errors[0].message);
                  return;
                }
                if (
                  !r.meta.fields?.some((k) =>
                    ["物料编码", "code", "物料名称", "名称", "name"].includes(k),
                  ) ||
                  !r.meta.fields?.some((k) => ["数量", "qty"].includes(k))
                ) {
                  setError("文件须包含数量列，以及物料编码或物料名称列");
                  return;
                }
                if (r.data.length > 5000) {
                  setError("每次最多导入 5000 行");
                  return;
                }
                setRows(
                  r.data.map((x) => ({
                    code: x["物料编码"] ?? x.code,
                    name: x["物料名称"] ?? x["名称"] ?? x.name,
                    external_code: x["外部料号"] ?? x.external_code,
                    material_level: x["级别"] ?? x.material_level,
                    category: x["类别"] ?? x.category,
                    spec: x["规格型号"] ?? x.spec,
                    qty: x["数量"] ?? x.qty,
                    unit: x["单位"] ?? x.unit,
                    price: x["参考单价"] ?? x["单价"] ?? x.price,
                    reference: x["位号"] ?? x.reference ?? "",
                    notes: x["备注"] ?? x.notes ?? "",
                  })),
                );
              },
            });
          }}
        />
      </label>
      {rows.length > 0 && (
        <p className="stock-hint">
          已读取 {rows.length} 行，导入失败时会整体回滚。
        </p>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="dialog-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button
          primary
          disabled={!rows.length || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await submit(rows);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={16} className="spin" />}确认导入
        </Button>
      </div>
    </>
  );
}
function FileManager({
  owner,
  id,
  items,
  onRefresh,
  onError,
  onPreview,
  onDelete,
}: {
  owner: string;
  id: string;
  items: FileRecord[];
  onRefresh: () => Promise<any>;
  onError: (s: string) => void;
  onPreview: (f: FileRecord) => void;
  onDelete: (f: FileRecord) => void;
}) {
  const { id: projectId, archived } = useContext(ProjectContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (fs: FileList | File[] | null, replace?: string) => {
    if (!fs?.length || archived) return;
    setBusy(true);
    setError("");
    try {
      await uploadProjectFiles(projectId, owner, id, Array.from(fs), replace);
      await onRefresh();
      onError(replace ? "文件已替换" : "文件已上传");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="file-manager"
      onPaste={(e) => {
        const files = pasteEventImages(e);
        if (files.length && !busy && !archived) {
          e.preventDefault();
          upload(files);
        }
      }}
    >
      <div className="file-heading">
        <div>
          <h3>
            图片与附件 <span className="muted">{items.length} 个文件</span>
          </h3>
        </div>
        {!archived && <Button
          disabled={busy}
          onClick={async () => {
            try {
              await upload(await readClipboardImages());
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <ImageIcon size={15} />
          粘贴图片
        </Button>}
        {!archived && <label className={`btn primary ${busy ? "disabled" : ""}`}>
          <Upload size={16} />
          {busy ? "正在上传…" : "上传文件"}
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
            hidden
          />
        </label>}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="file-grid">
        {items.map((f) => (
          <div className="file-card" key={f.id}>
            {f.kind === "image" ? (
              <button className="file-image" onClick={() => onPreview(f)}>
                <img src={fileUrl(f.id)} alt={f.name} />
              </button>
            ) : (
              <a
                className="file-image attachment"
                href={fileUrl(f.id)}
                download={f.name}
              >
                <FileText size={38} />
                <span>下载附件</span>
              </a>
            )}
            <div className="file-info">
              <strong title={f.name}>{f.name}</strong>
              {f.kind !== "image" && f.original_name && (
                <span className="file-original-name" title={f.original_name}>
                  {f.original_name}
                </span>
              )}
              <span>{(f.size / 1024).toFixed(1)} KB</span>
              <div className="file-actions">
                {!archived && <label className="text-link">
                  <RefreshCw size={13} />
                  替换
                  <input
                    type="file"
                    hidden
                    disabled={busy}
                    accept={
                      f.kind === "image"
                        ? "image/png,image/jpeg,image/webp,image/gif,image/bmp"
                        : undefined
                    }
                    onChange={(e) => {
                      upload(e.target.files, f.id);
                      e.target.value = "";
                    }}
                  />
                </label>}
                <a className="text-link" href={fileUrl(f.id)} download={f.name}>
                  <Download size={13} />
                </a>
                {!archived && <button
                  className="text-link"
                  title="删除文件"
                  onClick={() => onDelete(f)}
                >
                  <Trash2 size={14} />
                </button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {!items.length && !archived && (
        <label className="upload-zone file-empty">
          <ImageIcon size={30} />
          <strong>上传图片或附件</strong>
          <span>
            点击上传图片、规格书或图纸。
          </span>
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => upload(e.target.files)}
          />
        </label>
      )}
    </div>
  );
}
function QRPanel({ part }: { part: Part }) {
  const { id: projectId } = useContext(ProjectContext);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const url = location.origin + appBase + workspaceHash({ projectId, view: "parts", detail: part.id });
  useEffect(() => {
    QRCode.toDataURL(url, {
      width: 600,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#202725", light: "#ffffff" },
    })
      .then(setImage)
      .catch((e) => setError(e.message));
  }, [url]);
  return (
    <>
      {error && <div className="form-error">{error}</div>}
      <div className="qr-label" id="print-label">
        {image && <img src={image} alt={"物料二维码 " + part.code} />}
        <strong className="mono">{part.code}</strong>
        <h3>{part.name}</h3>
        <p>{part.spec}</p>
      </div>
      <p className="table-note">
        手机需能访问当前服务器域名。更换域名后，请重新生成二维码。
      </p>
      <div className="dialog-actions">
        <a className="btn" href={image} download={part.code + ".png"}>
          <Download size={16} />
          下载二维码
        </a>
        <Button primary onClick={() => window.print()}>
          <Printer size={16} />
          打印标签
        </Button>
      </div>
    </>
  );
}
function Scanner({
  parts,
  aliases,
  onFound,
}: {
  parts: Part[];
  aliases: { code: string; part_id: string }[];
  onFound: (p: Part) => void;
}) {
  const { id: projectId } = useContext(ProjectContext);
  const [input, setInput] = useState("");
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const found = useRef(onFound);
  found.current = onFound;
  function resolve(value: string) {
    let id = "";
    try {
      const u = new URL(value);
      if (u.hash.startsWith("#parts/")) id = u.hash.slice(7);
      const [top, project, view, detail] = u.hash.slice(1).split("/");
      if (top === "projects" && project === projectId && view === "parts") id = detail;
    } catch {}
    const p = parts.find(
      (p) =>
        p.id === id ||
        p.code === value.trim() ||
        aliases.some((a) => a.code === value.trim() && a.part_id === p.id),
    );
    if (p) {
      found.current(p);
      return true;
    }
    setError("未找到对应物料，请检查编码或确认二维码来自当前系统。");
    return false;
  }
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  useEffect(() => {
    if (!camera) return;
    let active = true;
    let stream: MediaStream | null = null;
    let frame = 0;
    let last = 0;
    let decoder: typeof import("jsqr").default | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = (time: number) => {
      if (!active) return;
      const v = video.current;
      if (v && v.readyState === 4 && time - last > 180 && ctx) {
        last = time;
        canvas.width = Math.min(v.videoWidth, 720);
        canvas.height = (v.videoHeight * canvas.width) / v.videoWidth;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = decoder?.(data.data, data.width, data.height, {
          inversionAttempts: "attemptBoth",
        });
        if (code) {
          if (resolveRef.current(code.data)) {
            active = false;
            stream?.getTracks().forEach((t) => t.stop());
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "当前环境不能调用摄像头，请使用 HTTPS 或 localhost，也可直接输入编码。",
      );
      setCamera(false);
      return;
    }
    import("jsqr")
      .then((module) => {
        decoder = module.default;
        if (!active) throw Error("closed");
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      })
      .then(async (s) => {
        stream = s;
        if (!active) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play();
          frame = requestAnimationFrame(tick);
        }
      })
      .catch(() => {
        if (active) {
          setError("无法打开摄像头，请检查权限或使用扫码枪输入。");
          setCamera(false);
        }
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camera]);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          resolve(input);
        }}
      >
        <label className="form-label">
          物料编码或二维码链接
          <div className="scan-input">
            <input
              autoFocus
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError("");
              }}
              placeholder="输入编码，或使用扫码枪扫描后回车"
              required
            />
            <Button type="submit" primary>
              <Search size={16} />
              查询
            </Button>
          </div>
        </label>
      </form>
      {camera ? (
        <div className="camera-view">
          <video ref={video} playsInline muted />
          <div className="scan-frame" />
          <Button small onClick={() => setCamera(false)}>
            关闭摄像头
          </Button>
        </div>
      ) : (
        <button
          className="camera-start"
          onClick={() => {
            setError("");
            setCamera(true);
          }}
        >
          <Camera size={29} />
          <strong>打开摄像头扫码</strong>
          <span>手机浏览器请使用 HTTPS 访问</span>
        </button>
      )}
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

function InlineCell({
  label,
  value,
  save,
  type = "text",
  min = 0,
  required = false,
  options,
  categoryOptions,
  createOptionLabel,
}: {
  label: string;
  value: string | number;
  save: (value: string) => Promise<void>;
  type?: string;
  min?: number;
  required?: boolean;
  options?: { value: string; label: string }[];
  categoryOptions?: string[];
  createOptionLabel?: string;
}) {
  const { archived } = useContext(ProjectContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const committing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      if (type !== "number") input.current?.select();
    }
  }, [editing]);
  async function commit(next = draft) {
    if (committing.current || cancelled.current) return;
    if (next === String(value ?? "")) {
      setEditing(false);
      return;
    }
    if (required && !next.trim()) {
      setError("名称不能为空");
      return;
    }
    if (
      type === "number" &&
      (!next.trim() || !Number.isFinite(Number(next)) || Number(next) < min)
    ) {
      setError("请输入有效数字");
      return;
    }
    committing.current = true;
    setBusy(true);
    setError("");
    try {
      await save(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      committing.current = false;
      setBusy(false);
    }
  }
  const display = options?.find((option) => option.value === String(value))?.label ?? String(value ?? "");
  const content = display && (options || categoryOptions)
    ? <OptionTag label={display} tone={categoryOptions && materialCategoryTone(display, categoryOptions)} />
    : display || "—";
  if (archived) return <span>{content}</span>;
  if (!editing)
    return (
      <button
        className={"inline-cell " + (!String(value ?? "") ? "unset" : "")}
        aria-label={"编辑" + label}
        title={"编辑" + label}
        onClick={() => {
          cancelled.current = false;
          setDraft(String(value ?? ""));
          setError("");
          setEditing(true);
        }}
      >
        <span className="cell-value">{content}</span>
        <Pencil size={11} />
      </button>
    );
  return (
    <div className={"inline-editor" + (options ? " select-editor" : "")}>
      {categoryOptions ? <MaterialCategory label={label} value={draft} options={categoryOptions} disabled={busy}
        autoOpen onDismiss={() => { if (!committing.current) setEditing(false); }}
        onChange={(value) => { setDraft(value); void commit(value); }} /> : options ? (
        <TableOptionPicker label={label} value={draft} choices={options} disabled={busy} autoOpen
          allowNew={!!createOptionLabel} searchLabel={createOptionLabel} searchPlaceholder={createOptionLabel}
          onDismiss={() => { if (!committing.current) setEditing(false); }}
          onChange={(value) => { setDraft(value); void commit(value); }} />
      ) : (
        <input
          ref={input}
          aria-label={label}
          type={type}
          step="any"
          min={type === "number" ? min : undefined}
          disabled={busy}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError("");
          }}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelled.current = true;
              setEditing(false);
            }
          }}
        />
      )}
      <button
        className="inline-cancel"
        title="取消编辑"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          cancelled.current = true;
          setEditing(false);
        }}
        disabled={busy}
      >
        <X size={12} />
      </button>
      {busy && <Loader2 size={12} className="spin" />}
      {error && (
        <span role="alert" className="cell-error">
          {error}
        </span>
      )}
    </div>
  );
}
function MaterialPhoto({
  name,
  items,
  preview,
}: {
  name: string;
  items: FileRecord[];
  preview: (file: FileRecord) => void;
}) {
  return (
    <div className="material-photo-cell">
      {items.length ? (
        <button
          className="material-photo"
          aria-label={"预览" + name + "图片"}
          onClick={() => preview(items[0])}
        >
          <img src={fileUrl(items[0].id)} alt={name} />
          {items.length > 1 && <span>{items.length}</span>}
        </button>
      ) : (
        <span className="material-photo empty-photo">
          <ImageIcon size={20} />
        </span>
      )}
    </div>
  );
}
function ImagePasteArea({
  selected,
  addImages,
  removeImage,
  setError,
  busy,
}: {
  selected: File[];
  addImages: (files: File[]) => void;
  removeImage: (index: number) => void;
  setError: (error: string) => void;
  busy: boolean;
}) {
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = selected.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [selected]);
  return (
    <div
      className="quick-create-images paste-image-area"
      tabIndex={0}
      aria-label="图片粘贴区域"
    >
      <div className="quick-previews">
        {previews.map((u, i) => (
          <div key={u}>
            <img src={u} alt={selected[i]?.name} />
            <button
              type="button"
              title="移除图片"
              disabled={busy}
              onClick={() => removeImage(i)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="paste-actions">
        <Button
          small
          type="button"
          disabled={busy}
          onClick={async () => {
            setError("");
            try {
              addImages(await readClipboardImages());
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <ImageIcon size={16} />
          粘贴图片
        </Button>
        <span>⌘V / Ctrl+V</span>
        <label className={"btn small " + (busy ? "disabled" : "")}>
          <ImageIcon size={15} />
          选择文件
          <input
            aria-label="添加图片"
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            multiple
            disabled={busy}
            onChange={(e) => {
              addImages(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
function QuickCreateForm({
  images,
  fields,
  initial,
  parents,
  suppliers,
  create,
  upload,
  done,
  onCancel,
}: {
  images: boolean;
  fields: Field[];
  initial: any;
  parents?: Part[];
  suppliers?: SupplierOption[];
  create: (data: any) => Promise<string>;
  upload: (id: string, files: File[]) => Promise<void>;
  done: (id: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [values, setValues] = useState<any>(initial);
  const [parentIds, setParentIds] = useState<string[]>(
    initial.parent_ids || [],
  );
  const [selected, setSelected] = useState<File[]>([]);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>({ ids: [], names: [], pending: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const created = useRef("");
  const uploaded = useRef(false);
  function addImages(files: File[]) {
    if (!files.length) return;
    setSelected((current) => [...current, ...files]);
    uploaded.current = false;
    setError("");
  }
  return (
    <form
      onPaste={(e) => {
        const files = pasteEventImages(e);
        if (files.length && images && !busy) {
          e.preventDefault();
          addImages(files);
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          if (!created.current)
            created.current = await create({
              ...values,
              name,
              parent_ids: parents ? parentIds : undefined,
              supplier_changes: suppliers ? supplierChanges(supplierDraft) : undefined,
            });
          if (selected.length && !uploaded.current) {
            await upload(created.current, selected);
            uploaded.current = true;
          }
          await done(created.current);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {images && (
        <ImagePasteArea
          selected={selected}
          busy={busy}
          addImages={addImages}
          setError={setError}
          removeImage={(index) => {
            uploaded.current = false;
            setSelected((files) => files.filter((_, i) => i !== index));
          }}
        />
      )}
      <label className="form-label">
        名称
        <input
          autoFocus
          required
          aria-label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy || !!created.current}
          autoComplete="off"
        />
      </label>
      {suppliers && <SupplierLinksInput options={suppliers} draft={supplierDraft}
        onChange={setSupplierDraft} disabled={busy || !!created.current} />}
      {fields
        .filter((f) => f.name === "english_code")
        .map((f) => (
          <label key={f.name} className="form-label create-english-code">
            {f.label}
            <input
              aria-label={f.label}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              disabled={busy || !!created.current}
              onChange={(e) =>
                setValues({ ...values, [f.name]: e.target.value.toUpperCase() })
              }
            />
          </label>
        ))}
      <section className="optional-fields expanded-fields">
        <div className="section-label">
          其他信息 <span>选填</span>
        </div>
        <div className="form-grid">
          {fields
            .filter((f) => f.name !== "english_code")
            .map((f) => (
              <label key={f.name} className={f.wide ? "wide-field" : ""}>
                {f.label}
                {f.categoryOptions ? <MaterialCategory label={f.label} value={values[f.name] ?? ""}
                  options={f.categoryOptions} disabled={busy || !!created.current} onChange={(value) =>
                    setValues((previous: any) => ({ ...previous, [f.name]: value }))} /> : f.options ? (
                  <ChoiceSelect
                    create={f.create}
                    disabled={busy || !!created.current}
                    aria-label={f.label}
                    value={values[f.name] ?? ""}
                    onValueChange={(value) =>
                      setValues((previous: any) => ({
                        ...previous,
                        [f.name]: value,
                      }))
                    }
                  >
                    <option value="">请选择</option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </ChoiceSelect>
                ) : f.type === "textarea" ? (
                  <textarea
                    disabled={busy || !!created.current}
                    aria-label={f.label}
                    rows={2}
                    value={values[f.name] ?? ""}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.value })
                    }
                  />
                ) : (
                  <input
                    disabled={busy || !!created.current}
                    aria-label={f.label}
                    type={f.type || "text"}
                    placeholder={f.placeholder}
                    min={f.type === "number" ? 0 : undefined}
                    step="any"
                    value={values[f.name] ?? ""}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.value })
                    }
                  />
                )}
              </label>
            ))}
        </div>
        {parents && (
          <div className="create-parents">
            <label className="form-label">关联一级物料</label>
            <RecordChoices
              records={parents}
              create={{
                resource: "parts",
                level: 1,
              }}
              selected={parentIds}
              onChange={setParentIds}
              disabled={busy || !!created.current}
            />
          </div>
        )}
      </section>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <Button type="button" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button primary type="submit" disabled={busy}>
          {busy && <Loader2 size={15} className="spin" />}保存
        </Button>
      </div>
    </form>
  );
}

function RecordChoices({
  records,
  selected,
  onChange,
  disabled = false,
  create,
}: {
  records: Part[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  create?: CreateChoice;
}) {
  const [search, setSearch] = useState("");
  const open = useContext(ChoiceContext);
  const toggle = (id: string) =>
    onChange(
      selected.includes(id)
        ? selected.filter((v) => v !== id)
        : [...selected, id],
    );
  const matches = records.filter((p) =>
    [p.name, p.code, p.spec]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="record-choices">
      <div className="selected-records">
        {selected.map((id) => {
          const record = records.find((p) => p.id === id);
          return (
            record && (
              <span className="record-tag" key={id}>
                <Package size={11} />
                {record.name}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={"取消选择" + record.name}
                  onClick={() => toggle(id)}
                >
                  <X size={12} />
                </button>
              </span>
            )
          );
        })}
      </div>
      <div className="search-input">
        <Search size={15} />
        <input
          aria-label="搜索关联物料"
          placeholder="搜索名称、编号"
          value={search}
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {open && create && (
        <Button
          small
          type="button"
          disabled={disabled}
          onClick={() =>
            open({ ...create, select: (id) => onChange([...selected, id]) })
          }
        >
          <Plus size={14} />
          新建{create.level === 1 ? "一级物料" : "二级物料"}
        </Button>
      )}
      <div className="record-options">
        {matches.map((record) => (
          <label className="record-option" key={record.id}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(record.id)}
              onChange={() => toggle(record.id)}
              aria-label={record.name}
            />
            <span>
              <strong>{record.name}</strong>
              <small className="mono">{record.code}</small>
            </span>
            <span className="muted">{record.spec}</span>
          </label>
        ))}
        {!matches.length && <p className="no-options">暂无记录</p>}
      </div>
    </div>
  );
}
function RecordPicker({
  records,
  create,
  selected,
  submit,
  onCancel,
}: {
  records: Part[];
  create: CreateChoice;
  selected: string[];
  submit: (ids: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [ids, setIds] = useState(selected);
  return (
    <>
      <RecordChoices
        records={records}
        selected={ids}
        onChange={setIds}
        create={create}
      />
      <AsyncAction
        label="保存关联"
        onCancel={onCancel}
        action={() => submit(ids)}
      />
    </>
  );
}

function pasteEventImages(event: React.ClipboardEvent): File[] {
  const items = Array.from(event.clipboardData.items || []);
  return items
    .filter(
      (item) =>
        item.kind === "file" &&
        /^image\/(png|jpeg|webp|gif|bmp)$/.test(item.type),
    )
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}
async function readClipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read)
    throw Error("请在窗口内按 ⌘V / Ctrl+V 粘贴图片");
  let items: ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch {
    throw Error("无法读取剪贴板，请在窗口内按 ⌘V / Ctrl+V 粘贴图片");
  }
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find((t) =>
      /^image\/(png|jpeg|webp|gif|bmp)$/.test(t),
    );
    if (type) {
      const blob = await item.getType(type);
      files.push(
        new File(
          [blob],
          "粘贴图片-" +
            Date.now() +
            "-" +
            files.length +
            "." +
            (type === "image/jpeg" ? "jpg" : type.split("/")[1]),
          { type },
        ),
      );
    }
  }
  if (!files.length) throw Error("剪贴板中没有图片");
  return files;
}
function ElectronicImportForm({
  state,
  context,
  submit,
  onCancel,
}: {
  state: State;
  context: any;
  submit: (payload: any) => Promise<void>;
  onCancel: () => void;
}) {
  const { id: projectId } = useContext(ProjectContext);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [parent, setParent] = useState(context.parent_id || "");
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [updatePrices, setUpdatePrices] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const reset = () => {
    requestId.current = crypto.randomUUID();
  };
  async function readFile(f: File, sheet = "") {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    setPreview(null);
    setRows([]);
    reset();
    try {
      const form = new FormData();
      form.append("file", f);
      if (sheet) form.append("sheet", sheet);
      const data = await projectRequest(projectId, "electronic-import/preview", "POST", form);
      if (ticket !== generation.current) return;
      setPreview(data);
      setRows(data.rows);
      setIncludeExcluded(false);
    } catch (e) {
      if (ticket === generation.current) setError((e as Error).message);
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  const eligible = rows.filter(
    (r) => !r.errors.length && (!r.excluded || includeExcluded),
  );
  const selected = rows.filter((r) => r.selected);
  const primary = state.parts.filter((p) => p.material_level === 1);
  const secondary = state.parts.filter((p) => p.material_level === 2);
  function changeRow(index: number, patch: any) {
    reset();
    setRows((previous) =>
      previous.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }
  const shown = rows
    .map((r, i) => ({ ...r, index: i }))
    .filter((r) =>
      [r.name, r.external_code, r.spec, r.brand, r.notes]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  return (
    <div className="electronic-import">
      <label className="upload-zone compact-upload">
        <Upload size={23} />
        <strong>{file?.name || "选择电子物料 BOM"}</strong>
        <span>XLSX / CSV</span>
        <input
          type="file"
          aria-label="选择电子物料 BOM"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          disabled={busy}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) {
              setFile(picked);
              readFile(picked);
            }
          }}
        />
      </label>
      <div className="import-targets">
        <label>
          关联一级物料
          <ChoiceSelect
            create={{
              resource: "parts",
              level: 1,
            }}
            aria-label="导入关联一级物料"
            disabled={!!context.parent_id || busy}
            value={parent}
            onValueChange={(id) => {
              setParent(id);
              reset();
            }}
          >
            <option value="">不关联</option>
            {primary.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.code}
              </option>
            ))}
          </ChoiceSelect>
        </label>
        {preview && (
          <label>
            工作表
            <select
              aria-label="导入工作表"
              disabled={busy}
              value={preview.sheet}
              onChange={(e) => file && readFile(file, e.target.value)}
            >
              {preview.sheets.map((sheet: string) => (
                <option key={sheet}>{sheet}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {busy && !preview && (
        <div className="import-reading">
          <Loader2 size={18} className="spin" />
          正在读取文件…
        </div>
      )}
      {preview && (
        <>
          <div className="import-options">
            <label>
              <input
                type="checkbox"
                checked={includeExcluded}
                disabled={busy}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setIncludeExcluded(checked);
                  reset();
                  setRows((previous) =>
                    previous.map((r) =>
                      r.excluded
                        ? {
                            ...r,
                            selected:
                              checked && !r.errors.length && !r.match_error,
                          }
                        : r,
                    ),
                  );
                }}
              />
              包含不贴 / 不焊 / 测试点
            </label>
            <label>
              <input
                type="checkbox"
                checked={updatePrices}
                disabled={busy}
                onChange={(e) => {
                  setUpdatePrices(e.target.checked);
                  reset();
                }}
              />
              更新已有物料单价
            </label>
          </div>
          <div className="import-preview-bar">
            <span>
              共 {rows.length} 行 · 已选 {selected.length} 行 · 跳过{" "}
              {preview.skipped_rows} 行空白或汇总
            </span>
            <div className="search-input">
              <Search size={14} />
              <input
                aria-label="筛选导入明细"
                placeholder="筛选明细"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="table-wrap import-preview-table">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="全选可导入行"
                      checked={
                        eligible.length > 0 && eligible.every((r) => r.selected)
                      }
                      disabled={busy}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        reset();
                        setRows((previous) =>
                          previous.map((r) =>
                            !r.errors.length && (!r.excluded || includeExcluded)
                              ? { ...r, selected: checked }
                              : r,
                          ),
                        );
                      }}
                    />
                  </th>
                  <th>行</th>
                  <th>外部料号</th>
                  <th>名称</th>
                  <th className="num">用量</th>
                  <th>封装</th>
                  <th>品牌</th>
                  <th className="num">原表单价</th>
                  <th>备注</th>
                  <th>物料匹配</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((row) => (
                  <tr
                    key={row.index}
                    className={!row.selected ? "unselected" : ""}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={"选择第" + row.source_row + "行"}
                        disabled={busy || row.errors.length > 0}
                        checked={row.selected}
                        onChange={(e) =>
                          changeRow(row.index, { selected: e.target.checked })
                        }
                      />
                    </td>
                    <td className="muted">{row.source_row}</td>
                    <td className="mono">
                      {row.external_code || row.internal_code || "—"}
                    </td>
                    <td>
                      {row.name || "—"}
                      {row.errors.length > 0 && (
                        <small className="row-error">
                          {row.errors.join("；")}
                        </small>
                      )}
                      {row.warnings.map((warning: string) => (
                        <small key={warning} className="row-warning">
                          {warning}
                        </small>
                      ))}
                    </td>
                    <td className="num">{row.qty ?? "—"}</td>
                    <td>{row.spec || "—"}</td>
                    <td>{row.brand || "—"}</td>
                    <td className="num">{row.price ?? "—"}</td>
                    <td>{row.notes || "—"}</td>
                    <td>
                      <select
                        aria-label={"匹配第" + row.source_row + "行物料"}
                        disabled={busy}
                        value={row.target_part_id || ""}
                        onChange={(e) =>
                          changeRow(row.index, {
                            target_part_id: e.target.value,
                            match_error: "",
                            selected:
                              row.selected ||
                              (!row.excluded && !row.errors.length),
                          })
                        }
                      >
                        <option value="">
                          {row.match_id
                            ? "复用 " + row.match_code
                            : row.match_error
                              ? "请选择匹配物料"
                              : "自动新建"}
                        </option>
                        <option value="__new__">新建独立物料</option>
                        {secondary
                          .filter(
                            (p) =>
                              p.id === row.match_id ||
                              p.name.toLowerCase() === row.name.toLowerCase() ||
                              (row.external_code &&
                                p.external_code?.toLowerCase() ===
                                  row.external_code.toLowerCase()),
                          )
                          .slice(0, 30)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} · {p.code}
                            </option>
                          ))}
                      </select>
                      {row.match_error && (
                        <small className="row-error">{row.match_error}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 500 && (
            <p className="table-note">显示前 500 行，可搜索其余记录。</p>
          )}
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          primary
          disabled={busy || !selected.length}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (selected.some((r) => r.errors.length || r.match_error))
                throw Error("请先处理已勾选行的错误");
              await submit({
                request_id: requestId.current,
                parent_id: parent || null,
                version_id: context.version_id || null,
                update_existing_prices: updatePrices,
                rows: selected.map((r) => ({
                  name: r.name,
                  external_code: r.external_code,
                  internal_code: r.internal_code,
                  spec: r.spec,
                  brand: r.brand,
                  notes: r.notes,
                  reference: r.reference,
                  unit: r.unit,
                  qty: r.qty,
                  price: r.price,
                  target_part_id: r.target_part_id || "",
                })),
              });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={15} className="spin" />}导入{" "}
          {selected.length || ""} 项
        </Button>
      </div>
    </div>
  );
}

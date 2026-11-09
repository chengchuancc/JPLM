import React, { useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
  Part,
  Supplier,
  Quote,
  Purchase,
  Movement,
  FileRecord,
  User,
  UserOption,
  Activity,
} from "./types";
import {
  MaterialTable,
  ColumnVisibility,
  materialCategories,
  type Column,
} from "./material-table";
import "./style.css";

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
const appBase = new URL(".", document.baseURI).pathname;
const fileUrl = (id: string) => appBase + "files/" + encodeURIComponent(id);
async function api(path: string, method = "GET", data?: unknown) {
  const r = await fetch(appBase + "api/" + path, {
    method,
    headers:
      data instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: data
      ? data instanceof FormData
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
];
type Modal = { kind: string; item?: any; extra?: any } | null;
type Field = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
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
  productId?: string | null;
};
type ChoiceRequest = CreateChoice & {
  select: (id: string, updated: State) => void;
};
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
function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focus = () =>
      (
        el.current?.querySelector<HTMLElement>(
          'input:not([type="file"]),select,textarea',
        ) || el.current?.querySelector<HTMLElement>("button")
      )?.focus();
    focus();
    const key = (e: KeyboardEvent) => {
      if (
        Array.from(document.querySelectorAll('.dialog[aria-modal="true"]')).at(
          -1,
        ) !== el.current
      )
        return;
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
      if (e.key === "Tab") {
        const a = Array.from(
          el.current?.querySelectorAll<HTMLElement>(
            "button,input,select,textarea,a[href]",
          ) || [],
        ).filter((x) => !x.hasAttribute("disabled"));
        if (!a.length) return;
        if (e.shiftKey && document.activeElement === a[0]) {
          e.preventDefault();
          a[a.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === a[a.length - 1]) {
          e.preventDefault();
          a[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={el}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog ${wide ? "wide" : ""}`}
      >
        <div className="dialog-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
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
}) {
  const [values, setValues] = useState<any>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<File[]>([]);
  function addImages(files: File[]) {
    if (!files.length) return;
    try {
      setSelected(mergeImages(selected, files));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
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
          await submit(values);
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
          <label key={f.name} className={f.wide ? "wide-field" : ""}>
            {f.label}
            {f.required && <span className="required"> *</span>}
            {f.type === "textarea" ? (
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
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function loadActivity(before = 0) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "activity?" +
          new URLSearchParams({
            before: String(before),
            part: part || "",
            kind,
          }),
      );
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
              throw Error(
                result.error ||
                  (response.status === 413 ? "备份超过 1 GB" : "恢复失败"),
              );
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
function App() {
  const [auth, setAuth] = useState<{
    initialized: boolean;
    authenticated: boolean;
    user: User | null;
  } | null>(null);
  const [state, setState] = useState<State>(emptyState);
  const currentUser = auth?.user;
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [restored, setRestored] = useState(false);
  const [accountView, setAccountView] = useState("profile");
  const userOptions = state.users.map(({ id, name }) => ({
    value: id,
    label: name,
  }));
  const userName = (id: string | null) =>
    state.users.find((user) => user.id === id)?.name || "—";
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState("products");
  const [detail, setDetail] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部产品");
  const [materialLevel, setMaterialLevel] = useState(1);
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
  const [parentFilter, setParentFilter] = useState("");
  const [categories, setCategories] = useState<Record<string, string>>({});
  const categoryProps = (key: string) => ({
    category: categories[key] || "",
    setCategory: (value: string) =>
      setCategories((old) => ({ ...old, [key]: value })),
  });
  const matchesCategory = (key: string, part?: Part) =>
    !categories[key] || categories[key] === part?.category;
  const [layout, setLayout] = useState("grid");
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState("info");
  const [modal, setModal] = useState<Modal>(null);
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = (s: string) => setToast(s);
  async function refresh() {
    const s = await api("state");
    setState({ ...emptyState, ...s });
    setFatal("");
    return s as State;
  }
  async function load() {
    setLoading(true);
    try {
      const a = await api("auth/status");
      setAuth(a);
      if (a.authenticated && !a.user?.must_change) await refresh();
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const hash = () => {
      const [v, id] = location.hash.slice(1).split("/");
      if (navs.some((n) => n.id === v) || v === "settings") {
        setView(v);
        setDetail(id || "");
        setSearch("");
        setFilter(v === "products" ? "全部产品" : "全部");
      }
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => window.removeEventListener("hashchange", hash);
  }, []);
  useEffect(() => {
    const expire = () => {
      setAuth((a) => (a ? { ...a, authenticated: false } : a));
      setState(emptyState);
      setModal(null);
      setChoice(null);
    };
    window.addEventListener("plm-session-expired", expire);
    return () => window.removeEventListener("plm-session-expired", expire);
  }, []);
  useEffect(() => {
    if (!auth?.authenticated || auth.user?.must_change) return;
    const sync = () => {
      if (document.visibilityState === "visible")
        refresh().catch((e) => setFatal(e.message));
    };
    const timer = setInterval(sync, 15000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [auth?.authenticated, auth?.user?.must_change]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  function go(v: string, id = "") {
    setView(v);
    setDetail(id);
    setSearch("");
    setFilter(v === "products" ? "全部产品" : "全部");
    setTab("info");
    setVersion("");
    setMobile(false);
    location.hash = v + (id ? "/" + id : "");
  }
  async function mutate(
    path: string,
    method: string,
    d?: any,
    message = "已保存",
  ) {
    await api(path, method, d);
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
  const purchase = state.purchases.find((p) => p.id === detail);
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
  const visibleParts = state.parts.filter(
    (p) =>
      p.material_level === materialLevel &&
      matchesCategory(view, p) &&
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
    await api("material-cells/" + id, "PUT", { [key]: value });
    await refresh();
  }
  async function saveLine(id: string, key: string, value: string) {
    await api("bom-lines/" + id, "PUT", { [key]: value });
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
  const parentLinks = state.material_links.filter(
    (l) => l.child_id === part?.id,
  );
  function openMaterial(id: string, section = "info") {
    go("parts", id);
    setTab(section);
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
        options={options}
        save={(value) => savePart(p.id, field, value)}
      />
    );
  }
  function baseMaterialCells(p: Part) {
    return {
      code: (
        <button className="text-link mono" onClick={() => openMaterial(p.id)}>
          {p.code}
        </button>
      ),
      photo: materialPhoto(p),
      name: (
        <button
          className="text-link material-name"
          title={p.name}
          onClick={() => openMaterial(p.id)}
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
      category: materialCell(
        p,
        "category",
        "类别",
        materialCategories.map((value) => ({ value, label: value })),
      ),
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
  function inventoryRowActions(p: Part) {
    return [
      { label: "入库", icon: ArrowDownToLine },
      { label: "出库", icon: ArrowUpFromLine },
      { label: "退库", icon: RotateCcw },
      { label: "报废", icon: Archive },
    ].map(({ label, icon: Icon }) => (
      <button
        key={label}
        title={label}
        onClick={() => startInventory(label, p)}
      >
        <Icon size={15} />
      </button>
    ));
  }
  const levelColumns: Column[] = materialLevel === 2 ? ["parents"] : [];
  const childColumns: Column[] = materialLevel === 1 ? ["children"] : [];
  const bomColumns: Column[] = [
    "photo",
    "name",
    "category",
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
    ...levelColumns,
    "spec",
    "external_code",
    "brand",
    "unit",
    "price",
    "stock",
    "custodian",
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
  const title = navs.find((n) => n.id === view)?.name || "工作空间";
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
      options: ["结构物料", "电子物料"].map((x) => ({ value: x, label: x })),
    },
    {
      name: "numbering_product_id",
      label: "编号所属产品",
      create: { resource: "products" },
      options: state.products.map((p) => ({
        value: p.id,
        label: p.name + (p.english_code ? " · " + p.english_code : ""),
      })),
      wide: true,
    },
    {
      name: "custodian_id",
      label: "物料管理员",
      options: userOptions,
      wide: true,
    },
    { name: "external_code", label: "外部料号" },
    { name: "brand", label: "品牌" },
    { name: "spec", label: "规格 / 封装", wide: true },
    { name: "unit", label: "单位" },
    { name: "price", label: "单价", type: "number" },
    { name: "min_stock", label: "最低库存", type: "number" },
    { name: "location", label: "库位" },
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
  function movementTable(rows: Movement[]) {
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
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .reverse()
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
                      <Badge>{m.type}</Badge>
                      <small className="mono">{m.code}</small>
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => go("parts", m.part_id)}
                      >
                        {p?.name}
                      </button>
                      <small className="mono">{p?.code}</small>
                    </td>
                    <td className="num">
                      {["入库", "退库"].includes(m.type) ? "+" : "−"}
                      {amount(m.qty)} {p?.unit}
                    </td>
                    <td className="num">{amount(m.balance)}</td>
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
                    <td className="muted nowrap">{datetime(m.created_at)}</td>
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
  if (loading)
    return (
      <div className="loading-page">
        <BrandMark />
        <span>加载中…</span>
      </div>
    );
  if (fatal && !auth)
    return (
      <div className="loading-page">
        <AlertCircle />
        <p>{fatal}</p>
        <Button onClick={load}>重试</Button>
      </div>
    );
  if (!auth?.authenticated)
    return (
      <Login
        initialized={auth?.initialized || false}
        onLogin={load}
        restored={restored}
      />
    );
  if (currentUser?.must_change)
    return (
      <div className="login-page compact-login">
        <div className="login-card">
          <LoginBrand />
          <h2>修改初始密码</h2>
          <PasswordForm onSaved={load} />
          <Button
            onClick={async () => {
              await api("auth/logout", "POST");
              await load();
            }}
          >
            退出登录
          </Button>
        </div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <a className="brand" href="#products" onClick={() => go("products")}>
          <BrandMark />
          <strong>捷程未来PLM</strong>
        </a>
        <nav>
          {navs.map((n) => (
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
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setModal({ kind: "scan" })}>
            <ScanLine size={18} />
            扫码识别物料<span className="key">↵</span>
          </button>
          <button onClick={() => go("settings")}>
            <Settings size={18} />
            设置与数据
          </button>
          <div className="user-row">
            <Avatar user={currentUser} version={avatarVersion} />
            <div>
              <button
                className="text-link"
                onClick={() => {
                  setAccountView("profile");
                  go("settings");
                }}
              >
                <strong>{currentUser?.name}</strong>
              </button>
              <span>{currentUser?.role === "admin" ? "管理员" : "成员"}</span>
            </div>
            <button
              className="icon-btn"
              title="退出登录"
              onClick={async () => {
                await api("auth/logout", "POST");
                setState(emptyState);
                setAuth({ ...auth, authenticated: false });
              }}
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
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <button onClick={() => go(view)}>{title}</button>
            {detail && (
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
                setAccountView("profile");
                go("settings");
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
                onClick={() => refresh().catch((e) => setFatal(e.message))}
              >
                重试
              </Button>
            </div>
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
                <button className="back-btn" onClick={() => go("products")}>
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
                      <Button
                        small
                        onClick={() =>
                          setModal(
                            materialLevel === 2
                              ? {
                                  kind: "electronic-import",
                                  extra: {
                                    version_id: selectedVersion?.id,
                                    numbering_product_id: product?.id,
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
                    {...categoryProps("bom")}
                    columns={bomColumns}
                    hiddenColumns={hiddenColumns["bom"] || []}
                    rows={displayedBom.map((line) => {
                      const material = findPart(line.part_id)!;
                      return {
                        id: line.id,
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
                    <select
                      className="stock-filter"
                      aria-label="库存筛选"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      {["全部", "低库存", "无库存"].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
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
                          库位: p.location,
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
                    ...baseMaterialCells(material),
                    min_stock: materialCell(material, "min_stock", "最低库存"),
                    location: materialCell(material, "location", "库位"),
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
                  aria-label="返回物料库"
                  onClick={() => go("parts")}
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
                <button className="back-btn" onClick={() => go("parts")}>
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
                  <Button onClick={() => setTab("children")}>
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
                      <Button
                        small
                        onClick={() =>
                          setModal({
                            kind: "electronic-import",
                            extra: {
                              parent_id: part.id,
                              numbering_product_id: part.numbering_product_id,
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
                    {...categoryProps("children")}
                    columns={childrenColumns}
                    hiddenColumns={hiddenColumns["children"] || []}
                    rows={displayedChildren.map((link) => {
                      const child = findPart(link.child_id)!;
                      const saveLink = async (
                        field: "qty" | "reference" | "notes",
                        value: string,
                      ) => {
                        await api("material-links/" + link.id, "PUT", {
                          [field]: value,
                        });
                        await refresh();
                      };
                      return {
                        id: link.id,
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
                      <dt>编号所属产品</dt>
                      <dd>
                        {findProduct(part.numbering_product_id || "")?.name ||
                          "通用物料"}
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
              )}
              {tab === "files" && fileManager("parts", part.id)}
              {tab === "boms" && (
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
                      {state.bom_lines
                        .filter((l) => l.part_id === part.id)
                        .map((l) => {
                          const v = state.bom_versions.find(
                            (v) => v.id === l.version_id,
                          );
                          return (
                            <tr key={l.id}>
                              <td>
                                <button
                                  className="text-link"
                                  onClick={() => {
                                    go("products", v!.product_id);
                                    setVersion(v!.id);
                                  }}
                                >
                                  {findProduct(v?.product_id || "")?.name}
                                  <ArrowUpRight size={14} />
                                </button>
                              </td>
                              <td>{v?.name}</td>
                              <td className="num">
                                {amount(l.qty)} {part.unit}
                              </td>
                              <td>{l.reference || "—"}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  {!state.bom_lines.some((l) => l.part_id === part.id) && (
                    <Empty text="该物料还未添加到任何 BOM。" />
                  )}
                </div>
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
                              <td className="num">{amount(l.qty)}</td>
                              <td className="num">{amount(l.received)}</td>
                              <td className="num">
                                {amount(Math.max(0, l.qty - l.received))}
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
                  aria-label="返回供应商列表"
                  onClick={() => go("suppliers")}
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
                        return (
                          <React.Fragment key={p.id}>
                            <tr className="purchase-group">
                              <td>
                                <button
                                  className="text-link mono"
                                  onClick={() => go("purchases", p.id)}
                                >
                                  {p.code}
                                  <ArrowUpRight size={14} />
                                </button>
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
                                <Badge>{costStatus(p)}</Badge>
                                <small>
                                  {p.date} · {userName(p.responsible_id)}
                                </small>
                              </td>
                            </tr>
                            {lines.map((l) => {
                              const part = findPart(l.part_id);
                              return (
                                <tr key={l.id}>
                                  <td className="indented">
                                    <button
                                      className="text-link"
                                      onClick={() => go("parts", l.part_id)}
                                    >
                                      {part?.name}
                                    </button>
                                    <small className="mono">{part?.code}</small>
                                  </td>
                                  <td className="muted">{part?.spec}</td>
                                  <td className="num">
                                    {amount(l.qty)} {part?.unit}
                                  </td>
                                  <td className="num">{amount(l.received)}</td>
                                  <td className="num">
                                    {amount(Math.max(0, l.qty - l.received))}
                                  </td>
                                  <td className="num">
                                    {money(l.price * l.qty)}
                                  </td>
                                  <td>
                                    {l.received < l.qty &&
                                      !part?.deleted_at && (
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
                                          办理入库
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
                <button className="back-btn" onClick={() => go("purchases")}>
                  <ArrowLeft size={18} />
                </button>
                <div className="detail-title">
                  <div className="inline">
                    <h1 className="mono">{purchase.code}</h1>
                    <Badge>{costStatus(purchase)}</Badge>
                  </div>
                  <p>
                    {findSupplier(purchase.supplier_id)?.name}
                    <span>·</span>
                    {purchase.date}
                    <span>·</span>
                    {purchase.notes || "无备注"}
                  </p>
                </div>
                <Button
                  onClick={() =>
                    setModal({ kind: "purchase-owner", item: purchase })
                  }
                >
                  <Pencil size={15} />
                  负责人：{userName(purchase.responsible_id)}
                </Button>
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
                              <button
                                className="text-link"
                                onClick={() => go("parts", l.part_id)}
                              >
                                {p?.name}
                              </button>
                              <small>{p?.code}</small>
                            </td>
                            <td className="num">
                              {amount(l.qty)} {p?.unit}
                            </td>
                            <td className="num">{money(l.price)}</td>
                            <td className="num">{money(l.price * l.qty)}</td>
                            <td className="num">{amount(l.received)}</td>
                            <td className="num">
                              {amount(Math.max(0, l.qty - l.received))}
                            </td>
                            <td>
                              {p?.deleted_at ? (
                                <span className="muted">物料已删除</span>
                              ) : l.received < l.qty ? (
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
                                  入库
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
                        state.movements
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
                            时间: datetime(m.created_at),
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
                  <h1>设置与数据</h1>
                </div>
              </div>
              <div className="tabs page-tabs">
                {[
                  ["profile", "个人资料"],
                  ["activity", "操作记录"],
                  ["login-activity", "登录记录"],
                  ...(currentUser?.role === "admin"
                    ? [
                        ["users", "用户管理"],
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
                    setAuth(await api("auth/status"));
                    setAvatarVersion((version) => version + 1);
                    notify("已保存");
                  }}
                />
              )}
              {accountView === "activity" && <ActivityPanel />}
              {accountView === "login-activity" && (
                <ActivityPanel key="login" kind="login" />
              )}
              {currentUser?.role === "admin" && accountView === "users" && (
                <UserAdmin
                  actorId={currentUser.id}
                  onChange={async () => {
                    await refresh();
                    setAuth(await api("auth/status"));
                  }}
                />
              )}
              {currentUser?.role === "admin" && accountView === "backup" && (
                <div className="settings-grid">
                  <BackupPanel
                    onRestored={() => {
                      setState(emptyState);
                      setRestored(true);
                      setAccountView("profile");
                      go("products");
                      setAuth({
                        initialized: true,
                        authenticated: false,
                        user: null,
                      });
                    }}
                  />
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>示例数据</h3>
                      <Boxes size={18} />
                    </div>
                    <Button
                      disabled={
                        !!(
                          state.products.length ||
                          state.parts.length ||
                          state.suppliers.length
                        )
                      }
                      onClick={() => setModal({ kind: "demo" })}
                    >
                      载入示例数据
                    </Button>
                  </section>
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
                action={<Button onClick={() => go(view)}>返回列表</Button>}
              />
            )}
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
      {modal && (
        <ChoiceContext.Provider value={setChoice}>
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
                  numbering_product_id:
                    modal.kind === "bom-create"
                      ? product?.id
                      : modal.kind === "child-create"
                        ? findPart(modal.extra?.parent_id)
                            ?.numbering_product_id || null
                        : null,
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
                  const r = await api(
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
                  const fd = new FormData();
                  fd.append(
                    "owner_type",
                    modal.kind === "product" ? "products" : "parts",
                  );
                  fd.append("owner_id", id);
                  images.forEach((f) => fd.append("file", f));
                  await api("files", "POST", fd);
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
                  productId: modal.item.numbering_product_id,
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
                  onCancel={() => setModal(null)}
                  images={
                    modal.kind === "product"
                      ? {
                          upload: async (files) => {
                            const form = new FormData();
                            form.append("owner_type", "products");
                            form.append("owner_id", modal.item.id);
                            files.forEach((file) => form.append("file", file));
                            await api("files", "POST", form);
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
                    if (modal.kind === "product") {
                      await api("products/" + data.id, "PUT", data);
                    } else {
                      await mutate(
                        (modal.kind === "part" ? "parts/" : "suppliers/") +
                          data.id,
                        "PUT",
                        data,
                      );
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
                  productId: product?.id,
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
                  const r = await api("bom-versions", "POST", d);
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
          {modal.kind === "movement" && (
            <Dialog title="库存操作" onClose={() => setModal(null)}>
              <MovementForm
                state={state}
                initial={modal.item}
                onCancel={() => setModal(null)}
                submit={(d) =>
                  mutate("movements", "POST", d, "库存已更新，流水已记录")
                }
              />
            </Dialog>
          )}
          {modal.kind === "purchase-owner" && (
            <Dialog title="修改采购负责人" onClose={() => setModal(null)}>
              <EntityForm
                initial={{ responsible_id: modal.item.responsible_id }}
                fields={[
                  {
                    name: "responsible_id",
                    label: "采购负责人",
                    options: userOptions,
                    required: true,
                    wide: true,
                  },
                ]}
                onCancel={() => setModal(null)}
                submit={(data) =>
                  mutate("purchases/" + modal.item.id, "PUT", data)
                }
              />
            </Dialog>
          )}
          {modal.kind === "purchase" && (
            <Dialog title="新建采购单" wide onClose={() => setModal(null)}>
              <PurchaseForm
                state={state}
                defaultOwner={currentUser?.id || ""}
                onCancel={() => setModal(null)}
                submit={(d) => mutate("purchases", "POST", d, "采购单已创建")}
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
                  const result = await api(
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
                submit={(rows) =>
                  mutate(
                    "bom-import",
                    "POST",
                    { version_id: selectedVersion?.id, rows },
                    "BOM 已导入",
                  )
                }
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
                BOM、采购和库存流水。示例数据会保存到当前数据库，请在正式录入数据前体验。
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
      {choice && (
        <Dialog
          title={"新建" + choiceNames[choice.resource]}
          onClose={() => setChoice(null)}
        >
          <QuickCreateForm
            images={choice.resource !== "suppliers"}
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
              numbering_product_id: choice.productId || "",
            }}
            create={async (data) =>
              (await api(choice.resource, "POST", data)).id
            }
            upload={async (id, images) => {
              const form = new FormData();
              form.append("owner_type", choice.resource);
              form.append("owner_id", id);
              images.forEach((image) => form.append("file", image));
              await api("files", "POST", form);
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
function MovementForm({
  state,
  initial,
  submit,
  onCancel,
}: {
  state: State;
  initial: any;
  submit: (d: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState(initial.type || "入库");
  const [part, setPart] = useState(initial.part_id || "");
  const [source, setSource] = useState(initial.purchase_line_id || "");
  const [original, setOriginal] = useState(initial.original_id || "");
  const [qty, setQty] = useState(String(initial.qty || ""));
  const [product, setProduct] = useState(initial.product_id || "");
  const [handler, setHandler] = useState(initial.handler_id || "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const p = state.parts.find((p) => p.id === part);
  const originals = state.movements
    .filter((m) => m.type === "出库" && m.part_id === part)
    .map((m) => ({
      ...m,
      remaining:
        Math.round(
          (m.qty -
            state.movements
              .filter((r) => r.original_id === m.id)
              .reduce((s, r) => s + r.qty, 0)) *
            1e6,
        ) / 1e6,
    }))
    .filter((m) => m.remaining > 0);
  const sources = state.purchase_lines.filter(
    (l) => l.part_id === part && l.received < l.qty,
  );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await submit({
            type,
            part_id: part,
            qty,
            product_id: type === "出库" ? product : null,
            purchase_line_id: type === "入库" ? source : null,
            original_id: type === "退库" ? original : null,
            reason,
            handler_id: handler,
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
      <div className="form-grid">
        <PersonSelect
          users={state.users}
          label="经办人"
          value={handler}
          onChange={setHandler}
        />

        <label className="wide-field">选择物料 *</label>
        <SearchPart
          parts={state.parts}
          create={type === "入库" ? { resource: "parts" } : undefined}
          value={part}
          onChange={(v) => {
            setPart(v);
            setSource("");
            setOriginal("");
            setQty("");
          }}
        />
        {p && (
          <div className="stock-hint wide-field">
            当前库存{" "}
            <strong>
              {amount(p.stock)} {p.unit}
            </strong>
            <span>{p.spec}</span>
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
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                const l = sources.find((l) => l.id === e.target.value);
                if (l) setQty(String(Math.max(0, l.qty - l.received)));
              }}
            >
              <option value="">独立入库</option>
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {state.purchases.find((p) => p.id === l.purchase_id)?.code} ·
                  待入 {amount(l.qty - l.received)}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "退库" && (
          <label className="wide-field">
            原出库记录 *
            <select
              required
              value={original}
              onChange={(e) => setOriginal(e.target.value)}
            >
              <option value="">请选择原出库记录</option>
              {originals.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} · 可退 {amount(m.remaining)} {p?.unit} ·{" "}
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
      {error && (
        <div className="form-error">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
        <Button primary type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
          确认{type}
        </Button>
      </div>
    </form>
  );
}
function SearchPart({
  parts,
  create,
  value,
  onChange,
}: {
  parts: Part[];
  create?: CreateChoice;
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  return (
    <div className="part-selector wide-field">
      <input
        placeholder="搜索物料编码、名称、规格…"
        aria-label="搜索物料"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ChoiceSelect
        create={create}
        required
        aria-label="选择物料"
        value={value}
        onValueChange={onChange}
      >
        <option value="">请选择物料</option>
        {parts
          .filter(
            (p) =>
              p.id === value ||
              [p.name, p.code, p.spec]
                .join(" ")
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name} / {p.spec}
            </option>
          ))}
      </ChoiceSelect>
    </div>
  );
}
const PURCHASE_MATERIAL_PAGE_SIZE = 40;

function PurchaseMaterialPhoto({ imageId }: { imageId?: string }) {
  return (
    <span className="thumb purchase-material-photo" aria-hidden="true">
      {imageId ? (
        <img src={fileUrl(imageId)} alt="" loading="lazy" />
      ) : (
        <Package size={17} strokeWidth={1.4} />
      )}
    </span>
  );
}

function PurchaseMaterialPicker({
  state,
  photos,
  quotesByPart,
  selected,
  onToggle,
  onAdd,
}: {
  state: State;
  photos: Map<string, string>;
  quotesByPart: Map<string, Map<string, Quote>>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  const openChoice = useContext(ChoiceContext);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [product, setProduct] = useState("");
  const [page, setPage] = useState(0);
  const productById = new Map(state.products.map((item) => [item.id, item]));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = state.parts.filter((part) => {
    if (category && part.category !== category) return false;
    if (level && part.material_level !== Number(level)) return false;
    if (product && (part.numbering_product_id || "common") !== product)
      return false;
    const searchText = [part.code, part.name, part.spec, part.external_code, part.brand]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchText.includes(term));
  });
  const lastPage = Math.max(0, Math.ceil(matches.length / PURCHASE_MATERIAL_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PURCHASE_MATERIAL_PAGE_SIZE;
  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(0);
  };

  return (
    <section aria-label="选择采购物料">
      <div className="purchase-picker-toolbar">
        <div className="search-input">
          <Search size={15} />
          <input
            type="search"
            aria-label="搜索采购物料"
            placeholder="搜索料号、名称、规格、外部料号…"
            value={query}
            onChange={(event) => updateFilter(setQuery, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </div>
        {openChoice && (
          <Button
            small
            type="button"
            onClick={() =>
              openChoice({
                resource: "parts",
                level: level ? Number(level) : undefined,
                productId: product && product !== "common" ? product : undefined,
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
          {materialCategories.map((item) => <option key={item}>{item}</option>)}
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
          aria-label="归属产品"
          value={product}
          onChange={(event) => updateFilter(setProduct, event.target.value)}
        >
          <option value="">全部产品</option>
          <option value="common">通用物料</option>
          {state.products.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.english_code || item.code}
            </option>
          ))}
        </select>
      </div>
      <div className="purchase-picker-results" key={JSON.stringify([query, category, level, product, currentPage])}>
        {matches.slice(start, start + PURCHASE_MATERIAL_PAGE_SIZE).map((part) => {
          const checked = selected.has(part.id);
          const owner = part.numbering_product_id
            ? productById.get(part.numbering_product_id)
            : undefined;
          return (
            <button
              type="button"
              className="purchase-picker-row"
              aria-pressed={checked}
              key={part.id}
              onClick={() => onToggle(part.id)}
            >
              <PurchaseMaterialPhoto imageId={photos.get(part.id)} />
              <span className="purchase-material-name">
                <strong>{part.name}</strong>
                <small>{[part.code, part.spec, part.external_code].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="purchase-material-meta">
                <span>{part.category} · {part.material_level === 1 ? "一级" : "二级"}</span>
                <small>
                  {owner?.name || "通用物料"}
                  {!quotesByPart.get(part.id)?.size && " · 未关联供应商"}
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

function PurchaseForm({
  state,
  defaultOwner,
  submit,
  onCancel,
}: {
  state: State;
  defaultOwner: string;
  submit: (d: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const [preferredSupplier, setPreferredSupplier] = useState("");
  const [date, setDate] = useState(() => {
    const today = new Date();
    return [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
  });
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<PurchaseDraftLine[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { partsById, photos, quotesByPart } = React.useMemo(() => {
    const partsById = new Map(state.parts.map((part) => [part.id, part]));
    const photos = new Map<string, string>();
    for (const file of state.files) {
      if (file.owner_type === "parts" && file.kind === "image" && !photos.has(file.owner_id))
        photos.set(file.owner_id, file.id);
    }
    const quotesByPart = new Map<string, Map<string, Quote>>();
    for (const quote of state.quotes) {
      if (!quotesByPart.has(quote.part_id)) quotesByPart.set(quote.part_id, new Map());
      quotesByPart.get(quote.part_id)?.set(quote.supplier_id, quote);
    }
    return { partsById, photos, quotesByPart };
  }, [state.parts, state.files, state.quotes]);
  const selected = new Set(lines.map((line) => line.partId));
  const suppliersById = new Map(state.suppliers.map((supplier) => [supplier.id, supplier]));
  const firstQuotes = lines.length ? quotesByPart.get(lines[0].partId) : undefined;
  const supplierOptions = Array.from(firstQuotes?.keys() || []).filter(
    (id) =>
      suppliersById.has(id) &&
      lines.every((line) => quotesByPart.get(line.partId)?.has(id)),
  );
  const supplierId = supplierOptions.includes(preferredSupplier)
    ? preferredSupplier
    : supplierOptions[0] || "";
  const pricedLines = lines.map(({ partId, qty, priceOverride }) => {
    const part = partsById.get(partId);
    const quote = quotesByPart.get(partId)?.get(supplierId);
    const price = priceOverride?.supplierId === supplierId
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
  const removePart = (partId: string) =>
    setLines((current) => current.filter((line) => line.partId !== partId));
  const updateLine = (partId: string, fields: Partial<PurchaseDraftLine>) =>
    setLines((current) => current.map((line) =>
      line.partId === partId ? { ...line, ...fields } : line,
    ));
  const missingSupplier = lines.some((line) => !quotesByPart.get(line.partId)?.size);

  return (
    <form
      className="purchase-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!supplierId || !pricedLines.length || busy) return;
        setError("");
        setBusy(true);
        try {
          await submit({
            supplier_id: supplierId,
            responsible_id: owner,
            date,
            notes,
            lines: pricedLines,
          });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <PurchaseMaterialPicker
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
            return (
              <div className="purchase-form-line" key={line.partId}>
                <div className="purchase-selected-material">
                  <PurchaseMaterialPhoto imageId={photos.get(part.id)} />
                  <span className="purchase-material-name">
                    <strong>{part.name}</strong>
                    <small>
                      {part.code} · {part.unit}
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
          <select
            required
            disabled={!supplierOptions.length}
            value={supplierId}
            onChange={(event) => setPreferredSupplier(event.target.value)}
          >
            {!supplierOptions.length && (
              <option value="">{lines.length ? "无可选供应商" : "请先选择物料"}</option>
            )}
            {supplierOptions.map((id) => (
              <option key={id} value={id}>{suppliersById.get(id)?.name}</option>
            ))}
          </select>
          {!!lines.length && !supplierOptions.length && (
            <small className="purchase-supplier-hint" role="status">
              {missingSupplier
                ? "请先在物料库为未关联的物料添加供应商。"
                : "所选物料没有共同供应商，请分开下单。"}
            </small>
          )}
        </label>
        <PersonSelect
          users={state.users}
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
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <Button type="button" onClick={onCancel}>取消</Button>
        <Button primary type="submit" disabled={busy || !supplierId}>
          {busy && <Loader2 size={16} className="spin" />}创建采购单
        </Button>
      </div>
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
          必需列：<code>物料编码</code>、<code>数量</code>
        </p>
        <p>
          可选列：<code>位号</code>、<code>备注</code>。物料须已存在于物料库。
        </p>
        <Button
          small
          onClick={() =>
            exportCSV(
              [
                {
                  物料编码: "请替换为已有物料编码",
                  数量: 1,
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
        <span>UTF-8 编码 · 最多 5,000 行 · 20 MB</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            setError("");
            setRows([]);
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 20 * 1024 * 1024) {
              setError("文件不能超过 20 MB");
              return;
            }
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
                    ["物料编码", "code"].includes(k),
                  ) ||
                  !r.meta.fields?.some((k) => ["数量", "qty"].includes(k))
                ) {
                  setError("文件必须包含物料编码、数量两列");
                  return;
                }
                if (r.data.length > 5000) {
                  setError("每次最多导入 5000 行");
                  return;
                }
                setRows(
                  r.data.map((x) => ({
                    code: x["物料编码"] ?? x.code,
                    qty: x["数量"] ?? x.qty,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (fs: FileList | File[] | null, replace?: string) => {
    if (!fs?.length) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("owner_type", owner);
      fd.append("owner_id", id);
      if (replace) fd.append("replace_id", replace);
      for (const f of Array.from(fs)) fd.append("file", f);
      await api("files", "POST", fd);
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
        if (files.length && !busy) {
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
        <Button
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
        </Button>
        <label className={`btn primary ${busy ? "disabled" : ""}`}>
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
        </label>
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
                <label className="text-link">
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
                </label>
                <a className="text-link" href={fileUrl(f.id)} download={f.name}>
                  <Download size={13} />
                </a>
                <button
                  className="text-link"
                  title="删除文件"
                  onClick={() => onDelete(f)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {!items.length && (
        <label className="upload-zone file-empty">
          <ImageIcon size={30} />
          <strong>上传图片或附件</strong>
          <span>
            点击上传图片、规格书或图纸，每次最多 12 个文件，总计不超过 20 MB。
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
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const url = location.origin + appBase + "#parts/" + part.id;
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
}: {
  label: string;
  value: string | number;
  save: (value: string) => Promise<void>;
  type?: string;
  min?: number;
  required?: boolean;
  options?: { value: string; label: string }[];
}) {
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
        <span className="cell-value">
          {options?.find((x) => x.value === String(value))?.label ??
            (String(value ?? "") || "—")}
        </span>
        <Pencil size={11} />
      </button>
    );
  return (
    <div className={"inline-editor" + (options ? " select-editor" : "")}>
      {options ? (
        <select
          autoFocus
          aria-label={label}
          disabled={busy}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cancelled.current = true;
              setEditing(false);
            }
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
function mergeImages(previous: File[], files: File[]) {
  const next = [...previous, ...files];
  if (next.length > 12) throw Error("每次最多 12 张图片");
  if (next.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024)
    throw Error("图片总计不能超过 20 MB");
  return next;
}
function QuickCreateForm({
  images,
  fields,
  initial,
  parents,
  create,
  upload,
  done,
  onCancel,
}: {
  images: boolean;
  fields: Field[];
  initial: any;
  parents?: Part[];
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const created = useRef("");
  const uploaded = useRef(false);
  function addImages(files: File[]) {
    if (!files.length) return;
    try {
      setSelected(mergeImages(selected, files));
      uploaded.current = false;
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
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
          if (selected.length > 12) throw Error("每次最多 12 张图片");
          if (selected.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024)
            throw Error("图片总计不能超过 20 MB");
          if (!created.current)
            created.current = await create({
              ...values,
              name,
              parent_ids: parents ? parentIds : undefined,
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
                {f.options ? (
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
                productId: values.numbering_product_id,
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
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [parent, setParent] = useState(context.parent_id || "");
  const [product, setProduct] = useState(context.numbering_product_id || "");
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
      if (f.size > 20 * 1024 * 1024) throw Error("文件不能超过 20 MB");
      const form = new FormData();
      form.append("file", f);
      if (sheet) form.append("sheet", sheet);
      const data = await api("electronic-import/preview", "POST", form);
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
              productId: context.numbering_product_id,
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
        {!context.version_id && !parent && (
          <label>
            编号所属产品
            <ChoiceSelect
              create={{ resource: "products" }}
              aria-label="导入编号所属产品"
              disabled={busy}
              value={product}
              onValueChange={(id) => {
                setProduct(id);
                reset();
              }}
            >
              <option value="">通用物料 CM</option>
              {state.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.english_code ? " · " + p.english_code : ""}
                </option>
              ))}
            </ChoiceSelect>
          </label>
        )}
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
                numbering_product_id: product || null,
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

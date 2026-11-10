import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, SlidersHorizontal } from "lucide-react";
import { TableOptionPicker } from "./material-category";
import { materialCategoryTone } from "./option-tag";

const fields = {
  code: ["料号", 110],
  photo: ["图片", 74],
  name: ["名称", 185],
  parents: ["关联一级物料", 212],
  spec: ["规格 / 封装", 155],
  external_code: ["外部料号", 130],
  brand: ["品牌", 110],
  unit: ["单位", 78],
  category: ["类别", 134],
  qty: ["用量", 88],
  price: ["单价", 92],
  subtotal: ["小计", 100],
  stock: ["库存", 82],
  custodian: ["物料管理员", 126],
  min_stock: ["最低库存", 96],
  location: ["仓库位置", 112],
  reference: ["位号", 108],
  notes: ["备注", 168],
  level: ["级别", 112],
  children: ["二级物料", 108],
  actions: ["操作", 112],
} as const;

export type Column = keyof typeof fields;
type Row = { id: string; cells: Partial<Record<Column, ReactNode>> };
type Widths = Partial<Record<Column, number>>;
const maximumWidth = 640;
function minimumWidth(id: Column) {
  if (id === "code") return 100;
  if (id === "actions") return 112;
  if (id === "photo") return 62;
  if (id === "unit") return 68;
  if (id === "category" || id === "parents") return 112;
  return 80;
}
function clampWidth(id: Column, width: number) {
  return Math.max(minimumWidth(id), Math.min(maximumWidth, Math.round(width)));
}
const numeric = new Set<Column>([
  "qty",
  "price",
  "subtotal",
  "stock",
  "min_stock",
]);

export function ColumnVisibility({
  columns,
  hidden,
  onChange,
}: {
  columns: Column[];
  hidden: Column[];
  onChange: (hidden: Column[]) => void;
}) {
  return <FieldVisibility
    columns={(["code", ...columns, "actions"] as Column[]).map((key) => ({
      key, label: fields[key][0], fixed: key === "code" || key === "actions",
    }))}
    hidden={hidden} onChange={onChange} />;
}

export function FieldVisibility<Key extends string>({ columns, hidden, onChange }: {
  columns: { key: Key; label: string; fixed?: boolean }[];
  hidden: Key[];
  onChange: (hidden: Key[]) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details
      ref={menu}
      className="column-visibility"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menu.current?.open) return;
        event.stopPropagation();
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }}
    >
      <summary className="btn small">
        <SlidersHorizontal size={14} />
        显示字段
      </summary>
      <div className="column-visibility-menu">
        <div className="column-visibility-heading">
          <strong>显示字段</strong>
          <button
            className="text-link"
            type="button"
            onClick={() => onChange([])}
          >
            显示全部
          </button>
        </div>
        <div className="column-visibility-list">
          {columns.map(({ key: id, label, fixed }) => {
            return (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={fixed || !hidden.includes(id)}
                  disabled={fixed}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? hidden.filter((item) => item !== id)
                        : [...hidden, id],
                    )
                  }
                />
                {label}
                {fixed && <span>固定</span>}
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}

export function MaterialTable({
  tableId,
  columns,
  hiddenColumns,
  rows,
  category,
  categoryOptions,
  setCategory,
  empty,
}: {
  tableId: string;
  columns: Column[];
  hiddenColumns: Column[];
  rows: Row[];
  category: string;
  categoryOptions: string[];
  setCategory: (value: string) => void;
  empty: ReactNode;
}) {
  const storageKey = "plm-columns-" + tableId;
  const [order, setOrder] = useState<Column[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(saved))
        return [
          ...new Set(
            saved.filter(
              (id): id is Column =>
                typeof id === "string" && Object.hasOwn(fields, id),
            ),
          ),
        ];
    } catch {
      /* Browser storage can be unavailable. */
    }
    return [];
  });
  const widthKey = "plm-column-widths-" + tableId;
  const [widths, setWidths] = useState<Widths>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(widthKey) || "{}");
      const values: Widths = {};
      for (const id of Object.keys(fields) as Column[]) {
        if (typeof saved?.[id] === "number" && Number.isFinite(saved[id]))
          values[id] = clampWidth(id, saved[id]);
      }
      return values;
    } catch {
      return {};
    }
  });
  const widthOf = (id: Column) => widths[id] ?? fields[id][1];
  const resize = useRef<{
    id: Column;
    pointer: number;
    x: number;
    start: number;
    next: number;
  } | null>(null);
  function setWidth(id: Column, width: number | null, persist = false) {
    const next = { ...widths };
    if (width === null) delete next[id];
    else next[id] = clampWidth(id, width);
    setWidths(next);
    if (persist) {
      try {
        localStorage.setItem(widthKey, JSON.stringify(next));
      } catch {
        /* Width remains available for this session. */
      }
    }
  }
  const available: Column[] = columns.filter(
    (id) => id !== "code" && id !== "actions",
  );
  const ordered = [
    ...order.filter((id) => available.includes(id)),
    ...available.filter((id) => !order.includes(id)),
  ];
  const movable = ordered.filter((id) => !hiddenColumns.includes(id));
  const visible: Column[] = ["code", ...movable, "actions"];
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: Column; pointer: number; x: number } | null>(null);
  const [target, setTarget] = useState<Column | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function move(from: Column, to: Column) {
    const index = movable.indexOf(to);
    if (index < 0 || from === to) return;
    const all = [...order, ...available.filter((id) => !order.includes(id))];
    const next = all.filter((id) => id !== from);
    next.splice(
      next.indexOf(to) + (movable.indexOf(from) < index ? 1 : 0),
      0,
      from,
    );
    setOrder(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Session order still works. */
    }
    setAnnouncement(fields[from][0] + "已移至第 " + (index + 2) + " 列");
  }
  function columnAt(e: React.PointerEvent) {
    const header = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("th[data-column]");
    if (!header || !wrap.current?.contains(header)) return null;
    const id = header.getAttribute("data-column") as Column;
    return movable.includes(id) ? id : null;
  }
  const cellClass = (id: Column) =>
    [
      numeric.has(id) ? "num" : "",
      id === "code" ? "fixed-code" : "",
      id === "actions" ? "fixed-actions" : "",
    ].join(" ");

  return (
    <div className="table-wrap" ref={wrap}>
      <table
        className="editable-table configurable-table"
        style={{
          width: visible.reduce((sum, id) => sum + widthOf(id), 0),
        }}
      >
        <colgroup>
          {visible.map((id) => (
            <col key={id} style={{ width: widthOf(id) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {visible.map((id) => (
              <th
                key={id}
                scope="col"
                data-column={id}
                className={
                  cellClass(id) + (target === id ? " column-target" : "")
                }
              >
                <div className="column-heading">
                  {movable.includes(id) && (
                    <button
                      className="column-grip"
                      type="button"
                      aria-label={"移动" + fields[id][0] + "列"}
                      title="拖动调整列顺序，也可按左右方向键"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = {
                          id,
                          pointer: e.pointerId,
                          x: e.clientX,
                        };
                      }}
                      onPointerMove={(e) => {
                        if (
                          drag.current?.pointer !== e.pointerId ||
                          Math.abs(e.clientX - drag.current.x) < 5
                        )
                          return;
                        const box = wrap.current?.getBoundingClientRect();
                        if (box && e.clientX < box.left + 128)
                          wrap.current!.scrollLeft -= 16;
                        if (box && e.clientX > box.right - 128)
                          wrap.current!.scrollLeft += 16;
                        setTarget(columnAt(e));
                      }}
                      onPointerUp={(e) => {
                        if (drag.current?.pointer !== e.pointerId) return;
                        const to = columnAt(e);
                        if (to && Math.abs(e.clientX - drag.current.x) >= 5)
                          move(id, to);
                        drag.current = null;
                        setTarget(null);
                      }}
                      onLostPointerCapture={() => {
                        drag.current = null;
                        setTarget(null);
                      }}
                      onKeyDown={(e) => {
                        if (!["ArrowLeft", "ArrowRight"].includes(e.key))
                          return;
                        e.preventDefault();
                        const next =
                          movable[
                            movable.indexOf(id) +
                              (e.key === "ArrowLeft" ? -1 : 1)
                          ];
                        if (next) move(id, next);
                      }}
                    >
                      <GripVertical size={13} />
                    </button>
                  )}
                  {id === "category" ? (
                    <div className="column-filter">
                      <TableOptionPicker
                        label="类别筛选"
                        value={category}
                        choices={[{ value: "", label: "类别", tone: "slate" },
                          ...categoryOptions.map((item) => ({ value: item, label: item, tone: materialCategoryTone(item, categoryOptions) }))]}
                        onChange={setCategory}
                      />
                    </div>
                  ) : (
                    fields[id][0]
                  )}
                </div>
                <button
                  className="column-resizer"
                  type="button"
                  aria-label={"调整" + fields[id][0] + "列宽"}
                  title="拖动调整列宽，双击恢复默认"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const width = widthOf(id);
                    e.currentTarget.setPointerCapture(e.pointerId);
                    resize.current = {
                      id,
                      pointer: e.pointerId,
                      x: e.clientX,
                      start: width,
                      next: width,
                    };
                  }}
                  onPointerMove={(e) => {
                    const active = resize.current;
                    if (active?.pointer !== e.pointerId) return;
                    active.next = clampWidth(
                      id,
                      active.start + e.clientX - active.x,
                    );
                    setWidth(id, active.next);
                  }}
                  onPointerUp={(e) => {
                    const active = resize.current;
                    if (active?.pointer !== e.pointerId) return;
                    setWidth(id, active.next, true);
                    resize.current = null;
                  }}
                  onLostPointerCapture={() => {
                    const active = resize.current;
                    if (active?.id !== id) return;
                    setWidth(id, active.start);
                    resize.current = null;
                  }}
                  onDoubleClick={() => setWidth(id, null, true)}
                  onKeyDown={(e) => {
                    if (e.key === "Home") {
                      e.preventDefault();
                      setWidth(id, null, true);
                    } else if (
                      e.key === "ArrowLeft" ||
                      e.key === "ArrowRight"
                    ) {
                      e.preventDefault();
                      setWidth(
                        id,
                        widthOf(id) + (e.key === "ArrowRight" ? 10 : -10),
                        true,
                      );
                    }
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, cells }) => (
            <tr key={id}>
              {visible.map((column) => (
                <td key={column} className={cellClass(column)}>
                  {cells[column]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span className="table-announcement" role="status">
        {announcement}
      </span>
      {rows.length === 0 && empty}
    </div>
  );
}

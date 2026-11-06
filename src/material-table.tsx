import { useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

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
  min_stock: ["最低库存", 96],
  location: ["库位", 100],
  reference: ["位号", 108],
  notes: ["备注", 168],
  level: ["级别", 112],
  children: ["二级物料", 108],
  actions: ["操作", 112],
} as const;

type Column = keyof typeof fields;
type Row = { id: string; cells: Partial<Record<Column, ReactNode>> };
const numeric = new Set<Column>([
  "qty",
  "price",
  "subtotal",
  "stock",
  "min_stock",
]);
export const materialCategories = ["结构物料", "电子物料"];

export function MaterialTable({
  tableId,
  columns,
  rows,
  category,
  setCategory,
  empty,
}: {
  tableId: string;
  columns: Column[];
  rows: Row[];
  category: string;
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
  const available: Column[] = columns.filter(
    (id) => id !== "code" && id !== "actions",
  );
  const movable = [
    ...order.filter((id) => available.includes(id)),
    ...available.filter((id) => !order.includes(id)),
  ];
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
          minWidth: visible.reduce((sum, id) => sum + fields[id][1], 0),
        }}
      >
        <colgroup>
          {visible.map((id) => (
            <col key={id} style={{ width: fields[id][1] }} />
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
                    <select
                      aria-label="类别筛选"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="">类别：全部</option>
                      {materialCategories.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  ) : (
                    fields[id][0]
                  )}
                </div>
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

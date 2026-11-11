import { useLayoutEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { Printer } from "lucide-react";
import { Dialog } from "./dialog";
import labelCss from "./material-labels.css?inline";

export type LabelMaterial = { code: string; name: string };

const formats = [
  { width: 30, height: 40, barcodeHeight: 13 },
  { width: 50, height: 30, barcodeHeight: 10 },
] as const;
type LabelFormat = typeof formats[number];
const formatKey = "plm-material-label-format";

function formatCss({ width, height, barcodeHeight }: LabelFormat) {
  return `--label-width:${width}mm; --label-height:${height}mm; --barcode-height:${barcodeHeight}mm;`;
}

function createLabel(doc: Document, material: LabelMaterial) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  try {
    JsBarcode(svg, material.code, {
      format: "CODE128",
      width: 1,
      height: 30,
      margin: 0,
      marginLeft: 10,
      marginRight: 10,
      displayValue: false,
    });
  } catch {
    throw new Error(`无法生成条形码：${material.code}`);
  }
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", material.code + " 条形码");

  const code = doc.createElement("div");
  code.className = "material-label-code";
  code.textContent = material.code;
  const name = doc.createElement("div");
  name.className = "material-label-name";
  name.textContent = material.name;
  const label = doc.createElement("article");
  label.className = "material-barcode-label";
  label.append(svg, code, name);
  return { label, name };
}

function fitNames(names: HTMLElement[]) {
  // Resize only names that exceed the space beneath the barcode.
  let overflowing = names.filter((name) => name.scrollHeight > name.clientHeight);
  for (let points = 8.5; points >= 6 && overflowing.length; points -= 0.5) {
    for (const name of overflowing) name.style.fontSize = points + "pt";
    overflowing = overflowing.filter((name) => name.scrollHeight > name.clientHeight);
  }
}

export default function MaterialLabelsDialog({ materials, close }: {
  materials: LabelMaterial[];
  close: () => void;
}) {
  const [formatIndex, setFormatIndex] = useState(() => {
    try { return localStorage.getItem(formatKey) === "1" ? 1 : 0; }
    catch { return 0; }
  });
  const [error, setError] = useState("");
  const preview = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const format = formats[formatIndex];
  const first = materials[0];

  useLayoutEffect(() => {
    const container = preview.current;
    if (!container || !first) return;
    container.replaceChildren();
    try {
      const { label, name } = createLabel(container.ownerDocument, first);
      container.append(label);
      fitNames([name]);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [first, format]);

  function print() {
    const doc = frame.current?.contentDocument;
    const target = frame.current?.contentWindow;
    if (!doc || !target) {
      setError("无法打开打印窗口，请重试。");
      return;
    }
    try {
      const labels = materials.map((material) => createLabel(doc, material));
      const style = doc.createElement("style");
      style.textContent = labelCss + `
        @page { size: ${format.width}mm ${format.height}mm; margin: 0; }
        :root { ${formatCss(format)} }
        html, body { margin: 0; padding: 0; }
        article + article { break-before: page; }
      `;
      doc.documentElement.lang = "zh-CN";
      doc.head.replaceChildren(style);
      doc.title = "物料标签";
      doc.body.replaceChildren(...labels.map(({ label }) => label));
      fitNames(labels.map(({ name }) => name));
      setError("");
      target.focus();
      target.print();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return <Dialog title="打印物料标签" onClose={close}>
    <style>{labelCss + `.material-label-preview { ${formatCss(format)} }`}</style>
    <div className="material-label-options">
      <label>标签尺寸
        <select value={formatIndex} onChange={(event) => {
          const value = Number(event.target.value);
          setFormatIndex(value);
          try { localStorage.setItem(formatKey, String(value)); } catch { /* Use the current selection. */ }
        }}>
          {formats.map(({ width, height }, index) =>
            <option key={index} value={index}>{width} × {height} mm</option>)}
        </select>
      </label>
      <span>{materials.length} 张标签</span>
    </div>
    <div ref={preview} className="material-label-preview" aria-label="标签预览" />
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="btn" onClick={close}>取消</button>
      <button type="button" className="btn primary" onClick={print} disabled={!materials.length}>
        <Printer size={16} />打印
      </button>
    </div>
    <iframe ref={frame} className="material-label-print-frame" title="物料标签打印" tabIndex={-1} aria-hidden="true" />
  </Dialog>;
}

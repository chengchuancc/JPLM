import { useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Search } from "lucide-react";
import { CameraReader } from "./inspection";
import { path, type Request, type Device } from "./shipping-data";

export function DevicePicker({ request, devices, setDevices }: {
  request: Request; devices: Device[]; setDevices: (next: Device[]) => void;
}) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Device[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  function add(device: Device) {
    if (!devices.some((item) => item.serial === device.serial)) setDevices([...devices, { ...device, registered: true }]);
    setInput("");
    setResults([]);
    setMessage("");
  }
  async function search(value = input) {
    const term = value.trim();
    if (!term || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const found: Device[] = await request(path + "devices?" + new URLSearchParams({ q: term }));
      const exact = found.find((item) => item.serial.toLowerCase() === term.toLowerCase());
      if (exact) add(exact);
      else {
        setResults(found);
        if (!found.length) setMessage("当前项目没有匹配的设备");
      }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="shipping-device-picker">
    <h3>发货设备 <span className="muted">{devices.length} 台</span></h3>
    <div className="shipping-tools">
      <input aria-label="设备 S/N" placeholder="扫码或搜索设备 S/N" value={input} disabled={busy}
        onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void search();
          }
        }} />
      <button type="button" className="btn" disabled={!input.trim() || busy} onClick={() => void search()}><Search size={15} />查询</button>
      <button type="button" className="btn" disabled={busy} onClick={() => setCamera(true)}><Camera size={15} />扫码</button>
    </div>
    {message && <p className="muted" role="status">{message}</p>}
    {!!results.length && <div className="shipping-picker-list">
      {results.map((device) => <button type="button" key={device.serial} onClick={() => add(device)}>
        <span className="mono">{device.serial}</span><small>{[device.result, device.shipments && "已关联 " + device.shipments].filter(Boolean).join(" · ")}</small>
      </button>)}
    </div>}
    <div className="selected-records">
      {devices.map((device) => <span className="record-tag" key={device.serial}>
        <span className="mono">{device.serial}</span>
        {device.registered === false && <small>未匹配设备</small>}
        <button type="button" aria-label={"移除设备 " + device.serial} onClick={() =>
          setDevices(devices.filter((item) => item.serial !== device.serial))}>×</button>
      </span>)}
    </div>
    {camera && createPortal(<CameraReader live close={() => setCamera(false)} onRead={(value) => {
      setCamera(false);
      setInput(value);
      void search(value);
    }} />, document.body)}
  </section>;
}


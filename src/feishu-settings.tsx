import { TableScroll } from "./table-scroll";
import { useEffect, useState } from "react";

type Notification = "low_stock" | "入库" | "出库" | "退库" | "报废";
type Group = { name: string; chat_id: string; notifications: Notification[] };
const notificationChoices: { value: Notification; label: string }[] = [
  { value: "low_stock", label: "低库存" }, { value: "入库", label: "入库" },
  { value: "出库", label: "出库" }, { value: "退库", label: "退库" }, { value: "报废", label: "报废" },
];
type Settings = {
  app_id: string;
  enabled: boolean;
  queries: boolean;
  groups: Group[];
  configured: boolean;
  has_app_secret: boolean;
  has_verification_token: boolean;
  has_encrypt_key: boolean;
  chats: { chat_id: string; last_seen: number }[];
  jobs: { kind: string; chat_id: string; status: string; attempts: number; last_error: string; updated_at: number }[];
};
type Api = (path: string, method?: string, data?: unknown) => Promise<any>;

export function FeishuAccount({ api }: { api: Api }) {
  const [binding, setBinding] = useState<{ configured: boolean; enabled: boolean; bound: boolean; command?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("account/feishu").then((result) => {
      if (active) setBinding(result);
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [api]);
  async function update(method: string) {
    setBusy(true);
    setError("");
    try { setBinding(await api("account/feishu", method, method === "POST" ? {} : undefined)); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-heading"><h3>飞书账号</h3>
      {binding && <span className="muted">{binding.bound ? "已绑定" : "待绑定"}</span>}
    </div>
    <p>绑定后，在飞书私聊 JPLM 发送「查询物料 JC110001」「查询 前壳」或「低库存」，按当前 PLM 账号的项目权限查询。</p>
    {binding && !binding.enabled && <p className="table-note">请管理员先在「系统设置 → 飞书」配置并启用连接。</p>}
    {binding?.command && <>
      <label className="form-label">把整行命令发送给飞书机器人
        <input readOnly aria-label="飞书绑定命令" value={binding.command}
          onFocus={(event) => event.currentTarget.select()} />
      </label>
      <p className="table-note">绑定码 10 分钟内有效，使用后失效。</p>
    </>}
    <div className="dialog-actions">
      <button className="btn small" disabled={busy} onClick={() => void update("GET")}>刷新绑定状态</button>
      {binding?.bound && <button className="btn small" disabled={busy}
        onClick={() => void update("DELETE")}>解除绑定</button>}
      <button className="btn primary" disabled={busy || !binding?.configured || !binding?.enabled}
        onClick={() => void update("POST")}>生成绑定码</button>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}

export default function FeishuSettings({ api, callbackUrl }: {
  api: Api;
  callbackUrl: string;
}) {
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Settings>();
  const [appSecret, setAppSecret] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  const [clearEncrypt, setClearEncrypt] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function accept(settings: Settings) {
    setSaved(settings);
    setDraft(settings);
    setAppSecret("");
    setVerificationToken("");
    setEncryptKey("");
    setClearEncrypt(false);
  }

  useEffect(() => {
    let active = true;
    api("settings/feishu").then((settings: Settings) => {
      if (active) accept(settings);
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [api]);

  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  function groupChange(index: number, changes: Partial<Group>) {
    setDraft((previous) => previous && {
      ...previous,
      groups: previous.groups.map((group, position) => position === index ? { ...group, ...changes } : group),
    });
  }

  const retain = !!saved && saved.app_id === draft?.app_id;
  const canTest = !!saved?.configured;
  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-heading">
          <h3>飞书应用机器人</h3>
          <span className="muted">{saved?.configured ? (saved.enabled ? "已启用" : "已配置，待启用") : "待配置"}</span>
        </div>
        <p>在飞书自建应用中开启机器人，订阅方式选「将事件发送至开发者服务器」。消息收发使用下方应用凭据，Encrypt Key 与飞书加密策略保持一致。</p>
        <label className="form-label">
          事件请求地址
          <input readOnly aria-label="飞书事件请求地址" value={callbackUrl} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <p className="table-note">
          权限开启 im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly。
          添加「接收消息 v2.0」（im.message.receive_v1）事件，发布应用后把机器人加入项目群。
        </p>
        {draft && (
          <form autoComplete="off" onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              accept(await api("settings/feishu", "PUT", {
                ...draft, app_secret: appSecret, verification_token: verificationToken,
                encrypt_key: encryptKey, clear_encrypt_key: clearEncrypt,
              }));
              setNotice("飞书配置已保存。");
            });
          }}>
            <div className="form-grid">
              <label>App ID
                <input aria-label="飞书 App ID" value={draft.app_id} required maxLength={104}
                  autoCapitalize="none" spellCheck={false} disabled={busy}
                  onChange={(event) => setDraft({ ...draft, app_id: event.target.value })} />
              </label>
              <label>App Secret
                <input aria-label="飞书 App Secret" type="password" autoComplete="new-password"
                  value={appSecret} required={!(retain && saved?.has_app_secret)} maxLength={512} disabled={busy}
                  placeholder={retain && saved?.has_app_secret ? "已设置，留空保留" : ""}
                  onChange={(event) => setAppSecret(event.target.value)} />
              </label>
              <label>Verification Token
                <input aria-label="飞书 Verification Token" type="password" autoComplete="new-password"
                  value={verificationToken} required={!(retain && saved?.has_verification_token)}
                  maxLength={512} disabled={busy}
                  placeholder={retain && saved?.has_verification_token ? "已设置，留空保留" : ""}
                  onChange={(event) => setVerificationToken(event.target.value)} />
              </label>
              <label>Encrypt Key（选填）
                <input aria-label="飞书 Encrypt Key" type="password" autoComplete="new-password"
                  value={encryptKey} maxLength={512} disabled={busy || clearEncrypt}
                  placeholder={retain && saved?.has_encrypt_key ? "已设置，留空保留" : "与飞书加密策略保持一致"}
                  onChange={(event) => setEncryptKey(event.target.value)} />
              </label>
            </div>
            {saved?.has_encrypt_key && <label className="feishu-toggle">
              <input type="checkbox" checked={clearEncrypt} disabled={busy}
                onChange={(event) => setClearEncrypt(event.target.checked)} />清除 Encrypt Key
            </label>}
            <div className="feishu-toggles">
              <label className="feishu-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用飞书连接</label>
              <label className="feishu-toggle"><input type="checkbox" checked={draft.queries} disabled={busy}
                onChange={(event) => setDraft({ ...draft, queries: event.target.checked })} />物料查询（群聊 / 私聊）</label>
            </div>
            <p className="table-note">群通知仅涉及一级物料，按物料显示为一行，带「查看物料」链接。低库存持续不足期间发送一次，补足后再次不足会重新提醒；出入库、退库和报废仅通知新登记的记录。</p>
            <div className="panel-heading">
              <h3>飞书群与通知</h3>
              <button className="btn small" type="button" disabled={busy}
                onClick={() => setDraft({ ...draft, groups: [...draft.groups, { name: "", chat_id: "", notifications: [] }] })}>
                添加通知群
              </button>
            </div>
            <p className="table-note">群内查询覆盖所有项目，不按项目区分权限。每个群分别勾选接收的通知类型。先在群里 @机器人发送「帮助」，再点「刷新状态」即可选择群 ID；群名称可自行填写。</p>
            <datalist id="feishu-chat-choices">
              {(saved?.chats || []).map((chat) => <option key={chat.chat_id} value={chat.chat_id}>
                {saved?.groups.find((group) => group.chat_id === chat.chat_id)?.name || "已识别的群"}
              </option>)}
            </datalist>
            {draft.groups.map((group, index) => (
              <div className="feishu-binding" key={index}>
                <label>群名称
                  <input aria-label={"飞书群名称 " + (index + 1)} value={group.name} maxLength={100}
                    placeholder="例如：仓库通知群" disabled={busy}
                    onChange={(event) => groupChange(index, { name: event.target.value })} />
                </label>
                <label>飞书群 ID
                  <input aria-label={"飞书群 ID " + (index + 1)} value={group.chat_id} list="feishu-chat-choices"
                    required pattern="oc_[a-zA-Z0-9_-]+" maxLength={153} placeholder="oc_..." disabled={busy}
                    onChange={(event) => groupChange(index, { chat_id: event.target.value })} />
                </label>
                <button type="button" className="btn small" disabled={busy} onClick={() =>
                  setDraft({ ...draft, groups: draft.groups.filter((_, position) => position !== index) })}>移除</button>
                <div className="feishu-toggles feishu-group-notifications" role="group" aria-label={"群通知类型 " + (index + 1)}>
                  <span className="muted">接收通知</span>
                  {notificationChoices.map((choice) => <label className="feishu-toggle" key={choice.value}>
                    <input type="checkbox" checked={group.notifications.includes(choice.value)} disabled={busy}
                      onChange={(event) => groupChange(index, { notifications: event.target.checked
                        ? [...group.notifications, choice.value] : group.notifications.filter((value) => value !== choice.value) })} />
                    {choice.label}
                  </label>)}
                </div>
              </div>
            ))}
            <div className="dialog-actions">
              <button type="button" className="btn" disabled={busy || !canTest} onClick={() => void action(async () => {
                await api("settings/feishu/verify", "POST", {});
                setNotice("应用凭据和机器人能力验证通过。");
              })}>验证已保存的应用</button>
              <button className="btn primary" type="submit" disabled={busy}>{busy ? "处理中…" : "保存"}</button>
            </div>
          </form>
        )}
        <div className="feishu-actions">
          <button className="btn small" disabled={busy} onClick={() => void action(async () => {
            const latest: Settings = await api("settings/feishu");
            if (!draft) accept(latest);
            else setSaved(latest);
          })}>刷新状态</button>
          {(saved?.groups || []).map((group) =>
            <button className="btn small" key={group.chat_id} disabled={busy || !canTest}
              onClick={() => void action(async () => {
                await api("settings/feishu/test", "POST", { chat_id: group.chat_id });
                setNotice("测试消息已发送到「" + (group.name || group.chat_id) + "」。");
              })}>发送测试至 {group.name || "未命名群"}</button>)}
        </div>
        {error && <p role="alert" className="form-error">{error}</p>}
        {notice && <p role="status" className="shipping-notice">{notice}</p>}
      </section>
      <section className="panel">
        <div className="panel-heading"><h3>最近消息</h3></div>
        <p>群里 @机器人，发送「查询物料 JC110001」「查询 前壳」或「低库存」。查询包含一级和二级物料；「低库存」命令忽略库存为 0 的物料。</p>
        {saved?.jobs.length ? <TableScroll>
          <table>
            <thead><tr><th>类型</th><th>飞书群</th><th>状态</th><th>详情</th></tr></thead>
            <tbody>{saved.jobs.map((job, index) => <tr key={index}>
              <td>{{ query: "物料查询", low_stock: "低库存提醒", movement: "库存操作通知" }[job.kind] || job.kind}</td>
              <td title={job.chat_id}>{saved.groups.find((group) => group.chat_id === job.chat_id)?.name || job.chat_id}</td>
              <td>{{ pending: "等待发送", sent: "已发送", ignored: "已跳过", failed: "发送失败" }[job.status] || job.status}</td>
              <td>{job.last_error || "—"}</td>
            </tr>)}</tbody>
          </table>
        </TableScroll> : <p className="muted">暂无消息记录</p>}
      </section>
    </div>
  );
}

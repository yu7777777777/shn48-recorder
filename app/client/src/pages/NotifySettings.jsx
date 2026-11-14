import React, { useEffect, useState } from "react";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "../components/Toast";

const EVENT_LABELS = {
  recording_started: "开始录制",
  recording_done: "归档完成",
  recording_failed: "录制失败",
  upload_done: "B站投稿完成",
  upload_failed: "B站投稿失败",
  backup_done: "115备份完成",
  backup_failed: "115备份失败",
  analysis_done: "分析任务完成",
  analysis_failed: "分析任务失败",
  export_done: "转码导出完成",
  export_failed: "转码导出失败",
  pocket48_keyword: "口袋48关键词命中",
  failure_alert: "连续失败告警",
  update_available: "新版本可用",
};

const CHANNEL_LABELS = {
  telegram: "Telegram",
  email: "邮件 (SMTP)",
  serverchan: "Server酱",
  bark: "Bark",
  webhook: "通用 Webhook",
};

// The server never returns secrets; `xxxSet` says whether one is stored.
// Editing another field must not erase the stored credential, so secret inputs
// start empty and only overwrite when the user types something. Removing a
// stored credential goes through the per-channel "清除密钥" button, which sends
// `clear: [field…]` on the next save.
const SECRET_INPUTS = {
  telegram: ["botToken"],
  email: ["pass"],
  serverchan: ["sendKey"],
  bark: ["deviceKey"],
  webhook: ["secret"],
};

function Field({ label, children, hint }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {children}
      {hint && <small style={{ color: "var(--text-muted)", display: "block", marginTop: 4 }}>{hint}</small>}
    </div>
  );
}

function ClearSecret({ name, field, stored, cleared, onClear }) {
  if (cleared) return <small role="status" style={{ color: "var(--danger)" }}>保存后将清除该密钥</small>;
  if (!stored) return null;
  return <button type="button" className="btn btn-secondary btn-sm" onClick={() => onClear(name, field)}>清除已存密钥</button>;
}

export default function NotifySettings() {
  const [settings, setSettings] = useState(null);
  const [secrets, setSecrets] = useState({});
  const [clears, setClears] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState("");
  const [log, setLog] = useState([]);
  const toast = useToast();

  const load = async () => {
    try {
      const [settingsResult, logResult] = await Promise.all([
        adminApi.get("/notify/settings"),
        adminApi.get("/notify/log"),
      ]);
      setSettings(payload(settingsResult));
      setLog(payload(logResult, []));
    } catch (err) {
      toast.error(errorMessage(err, "通知设置读取失败"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  if (loading) return <div className="page-header"><h1>通知推送</h1><p role="status">正在读取…</p></div>;
  if (!settings) return <div className="page-header"><h1>通知推送</h1><p role="alert">设置读取失败，请刷新重试。</p></div>;

  const patchChannel = (name, patch) => setSettings(current => ({
    ...current,
    channels: { ...current.channels, [name]: { ...current.channels[name], ...patch } },
  }));
  const patchSecret = (channel, field, value) => setSecrets(current => ({ ...current, [`${channel}.${field}`]: value }));
  const markClear = (channel, field) => setClears(current => ({ ...current, [`${channel}.${field}`]: true }));
  const hasStoredSecret = (channel) => (SECRET_INPUTS[channel] || []).some(field => settings.channels[channel][`${field}Set`]);

  async function save() {
    setSaving(true);
    try {
      // Only non-empty secret inputs are sent; an empty input keeps the stored
      // credential server-side (same convention as the ASR/AI settings page).
      // `clear` names the stored credentials the user explicitly removed.
      const channels = {};
      for (const [name, channel] of Object.entries(settings.channels)) {
        const item = { ...channel };
        for (const field of SECRET_INPUTS[name] || []) {
          const typed = secrets[`${name}.${field}`];
          if (typed) item[field] = typed;
          else delete item[field];
          if (clears[`${name}.${field}`]) {
            item.clear = [...(item.clear || []), field];
          }
        }
        channels[name] = item;
      }
      const response = await adminApi.put("/notify/settings", { ...settings, channels });
      setSettings(payload(response));
      setSecrets({});
      setClears({});
      toast.success("通知设置已保存");
    } catch (err) {
      toast.error(errorMessage(err, "通知设置保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function test(channel) {
    setTesting(channel);
    try {
      await adminApi.post("/notify/test", { channel });
      toast.success(`${CHANNEL_LABELS[channel]} 测试通知已发送`);
      setLog(payload(await adminApi.get("/notify/log"), []));
    } catch (err) {
      toast.error(errorMessage(err, "测试发送失败"));
    } finally {
      setTesting("");
    }
  }

  const anyChannelEnabled = Object.values(settings.channels).some(channel => channel.enabled);

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>通知推送</h1>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
            无人值守外发通道：关键节点（开始录制 / 归档完成 / 投稿与备份完成 / 连续失败）主动推送到外部渠道。
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "正在保存…" : "保存设置"}
        </button>
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>总开关</h2></div>
        <label className="toggle-row">
          <div>
            <strong>启用外部通知推送</strong>
            <small>关闭后所有事件只留在站内，不再外发。密钥只保存在服务器，页面不回显。</small>
          </div>
          <input
            type="checkbox"
            style={{ width: 20, height: 20, accentColor: "var(--accent)" }}
            checked={settings.enabled}
            onChange={e => setSettings(current => ({ ...current, enabled: e.target.checked }))}
          />
        </label>
      </section>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>推送渠道</h2></div>
        <div className="grid-2">
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <label className="toggle-row" style={{ marginBottom: 10 }}>
              <strong>{CHANNEL_LABELS.telegram}</strong>
              <input type="checkbox" checked={settings.channels.telegram.enabled} onChange={e => patchChannel("telegram", { enabled: e.target.checked })} />
            </label>
            <Field label="Bot Token" hint={settings.channels.telegram.botTokenSet ? "已保存（留空保持不变）" : "格式 123456789:AA…，从 @BotFather 获取"}>
              <input type="password" autoComplete="new-password" value={secrets["telegram.botToken"] || ""} onChange={e => patchSecret("telegram", "botToken", e.target.value)} placeholder={settings.channels.telegram.botTokenSet ? "••••••（已保存）" : "123456789:AA…"} />
            </Field>
            <Field label="chat ID" hint="可向 @userinfobot 发送任意消息获取；群组 ID 为负数">
              <input value={settings.channels.telegram.chatId || ""} onChange={e => patchChannel("telegram", { chatId: e.target.value })} placeholder="例如 123456789 或 -1001234567890" />
            </Field>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === "telegram" || !settings.channels.telegram.botTokenSet} onClick={() => test("telegram")}>{testing === "telegram" ? "发送中…" : "发送测试"}</button>
            <ClearSecret name="telegram" field="botToken" stored={settings.channels.telegram.botTokenSet} cleared={Boolean(clears["telegram.botToken"])} onClear={markClear} />
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <label className="toggle-row" style={{ marginBottom: 10 }}>
              <strong>{CHANNEL_LABELS.email}</strong>
              <input type="checkbox" checked={settings.channels.email.enabled} onChange={e => patchChannel("email", { enabled: e.target.checked })} />
            </label>
            <div className="grid-2">
              <Field label="SMTP 服务器">
                <input value={settings.channels.email.host || ""} onChange={e => patchChannel("email", { host: e.target.value })} placeholder="smtp.example.com" />
              </Field>
              <Field label="端口" hint="465 隐式 TLS；587/25 自动 STARTTLS">
                <input type="number" value={settings.channels.email.port ?? 465} onChange={e => patchChannel("email", { port: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="账号">
                <input value={settings.channels.email.user || ""} onChange={e => patchChannel("email", { user: e.target.value })} placeholder="user@example.com" />
              </Field>
              <Field label="授权密码" hint={settings.channels.email.passSet ? "已保存（留空保持不变）" : "邮箱服务商生成的授权码，非登录密码"}>
                <input type="password" autoComplete="new-password" value={secrets["email.pass"] || ""} onChange={e => patchSecret("email", "pass", e.target.value)} placeholder={settings.channels.email.passSet ? "••••••（已保存）" : "授权码"} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="发件人">
                <input value={settings.channels.email.from || ""} onChange={e => patchChannel("email", { from: e.target.value })} placeholder="user@example.com" />
              </Field>
              <Field label="收件人">
                <input value={settings.channels.email.to || ""} onChange={e => patchChannel("email", { to: e.target.value })} placeholder="you@example.com" />
              </Field>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === "email" || !settings.channels.email.host} onClick={() => test("email")}>{testing === "email" ? "发送中…" : "发送测试"}</button>
            <ClearSecret name="email" field="pass" stored={settings.channels.email.passSet} cleared={Boolean(clears["email.pass"])} onClear={markClear} />
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <label className="toggle-row" style={{ marginBottom: 10 }}>
              <strong>{CHANNEL_LABELS.serverchan}</strong>
              <input type="checkbox" checked={settings.channels.serverchan.enabled} onChange={e => patchChannel("serverchan", { enabled: e.target.checked })} />
            </label>
            <Field label="SendKey" hint={settings.channels.serverchan.sendKeySet ? "已保存（留空保持不变）" : "从 sct.ftqq.com 获取，格式 SCT…"}>
              <input type="password" autoComplete="new-password" value={secrets["serverchan.sendKey"] || ""} onChange={e => patchSecret("serverchan", "sendKey", e.target.value)} placeholder={settings.channels.serverchan.sendKeySet ? "••••••（已保存）" : "SCT…"} />
            </Field>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === "serverchan" || !settings.channels.serverchan.sendKeySet} onClick={() => test("serverchan")}>{testing === "serverchan" ? "发送中…" : "发送测试"}</button>
            <ClearSecret name="serverchan" field="sendKey" stored={settings.channels.serverchan.sendKeySet} cleared={Boolean(clears["serverchan.sendKey"])} onClear={markClear} />
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <label className="toggle-row" style={{ marginBottom: 10 }}>
              <strong>{CHANNEL_LABELS.bark}</strong>
              <input type="checkbox" checked={settings.channels.bark.enabled} onChange={e => patchChannel("bark", { enabled: e.target.checked })} />
            </label>
            <Field label="服务器">
              <input value={settings.channels.bark.server || "https://api.day.app"} onChange={e => patchChannel("bark", { server: e.target.value })} placeholder="https://api.day.app（可自建）" />
            </Field>
            <Field label="deviceKey" hint={settings.channels.bark.deviceKeySet ? "已保存（留空保持不变）" : "Bark App 首页显示的推送 Key"}>
              <input type="password" autoComplete="new-password" value={secrets["bark.deviceKey"] || ""} onChange={e => patchSecret("bark", "deviceKey", e.target.value)} placeholder={settings.channels.bark.deviceKeySet ? "••••••（已保存）" : "推送 Key"} />
            </Field>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === "bark" || !settings.channels.bark.deviceKeySet} onClick={() => test("bark")}>{testing === "bark" ? "发送中…" : "发送测试"}</button>
            <ClearSecret name="bark" field="deviceKey" stored={settings.channels.bark.deviceKeySet} cleared={Boolean(clears["bark.deviceKey"])} onClear={markClear} />
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <label className="toggle-row" style={{ marginBottom: 10 }}>
              <strong>{CHANNEL_LABELS.webhook}</strong>
              <input type="checkbox" checked={settings.channels.webhook.enabled} onChange={e => patchChannel("webhook", { enabled: e.target.checked })} />
            </label>
            <Field label="Webhook 地址" hint="POST JSON：{event, title, text, timestamp}">
              <input value={settings.channels.webhook.url || ""} onChange={e => patchChannel("webhook", { url: e.target.value })} placeholder="https://example.com/hook" />
            </Field>
            <Field label="签名密钥（可选）" hint={settings.channels.webhook.secretSet ? "已保存（留空保持不变）" : "随请求头 X-48tools-Secret 发送，用于接收端校验"}>
              <input type="password" autoComplete="new-password" value={secrets["webhook.secret"] || ""} onChange={e => patchSecret("webhook", "secret", e.target.value)} placeholder={settings.channels.webhook.secretSet ? "••••••（已保存）" : "留空则不发送"} />
            </Field>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testing === "webhook" || !settings.channels.webhook.url} onClick={() => test("webhook")}>{testing === "webhook" ? "发送中…" : "发送测试"}</button>
            <ClearSecret name="webhook" field="secret" stored={settings.channels.webhook.secretSet} cleared={Boolean(clears["webhook.secret"])} onClear={markClear} />
          </div>
        </div>
        {!anyChannelEnabled && <p style={{ color: "var(--text-dim)", marginTop: 12 }}>尚未启用任何渠道。启用并保存后，事件才会外发。</p>}
      </section>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>通知事件</h2></div>
        <p style={{ color: "var(--text-muted)", marginTop: 0 }}>选择哪些事件触发推送。“分析任务完成”默认关闭：长录像逐场转写完成都会通知，按需打开。</p>
        <div className="grid-2">
          {Object.entries(EVENT_LABELS).map(([name, label]) => (
            <label key={name} className="toggle-row" style={{ padding: "8px 0" }}>
              <span>{label}</span>
              <input type="checkbox" checked={settings.events[name]} onChange={e => setSettings(current => ({ ...current, events: { ...current.events, [name]: e.target.checked } }))} />
            </label>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>连续失败告警</h2></div>
        <div className="grid-2">
          <Field label="连续失败次数阈值" hint="录制 / 投稿 / 备份 / 分析连续失败达到该次数时，额外发送一条告警；任一成功即重新计数。">
            <input type="number" min={1} max={50} value={settings.failures.threshold} onChange={e => setSettings(current => ({ ...current, failures: { ...current.failures, threshold: Number(e.target.value) } }))} />
          </Field>
          <Field label="告警冷却（分钟）" hint="同一类告警在此间隔内只发一次，避免半夜被轰炸。">
            <input type="number" min={5} max={1440} value={settings.failures.cooldownMinutes} onChange={e => setSettings(current => ({ ...current, failures: { ...current.failures, cooldownMinutes: Number(e.target.value) } }))} />
          </Field>
        </div>
      </section>

      <section className="card">
        <div className="card-title-row">
          <h2>最近发送记录</h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>刷新</button>
        </div>
        {!log.length ? <p style={{ color: "var(--text-dim)" }}>还没有发送记录。</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "6px 8px" }}>时间</th><th style={{ padding: "6px 8px" }}>事件</th><th style={{ padding: "6px 8px" }}>渠道</th><th style={{ padding: "6px 8px" }}>结果</th>
            </tr></thead>
            <tbody>
              {log.slice(0, 30).map((entry, index) => (
                <tr key={index} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{new Date(entry.at).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td style={{ padding: "6px 8px" }}>{EVENT_LABELS[entry.event] || entry.event}</td>
                  <td style={{ padding: "6px 8px" }}>{CHANNEL_LABELS[entry.channel] || entry.channel}</td>
                  <td style={{ padding: "6px 8px", color: entry.ok ? "var(--accent, green)" : "var(--danger, red)" }}>{entry.ok ? "成功" : `失败：${entry.error || "未知原因"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

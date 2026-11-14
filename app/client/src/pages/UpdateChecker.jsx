import React, { useEffect, useState } from "react";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "../components/Toast";

// Same masking contract as the notify page: the server never returns the
// token; `tokenSet` only says whether one is stored. The input starts empty
// and only overwrites when the user types something. Removing a stored token
// goes through the "清除已存 Token" button, which sends `clear: ["token"]`.
function Field({ label, children, hint }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {children}
      {hint && <small style={{ color: "var(--text-muted)", display: "block", marginTop: 4 }}>{hint}</small>}
    </div>
  );
}

function fmtTime(value) {
  if (!value) return "未检测";
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

export default function UpdateChecker() {
  const [settings, setSettings] = useState(null);
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const toast = useToast();

  const load = async () => {
    const res = await adminApi.get("/update/settings");
    const data = payload(res);
    setSettings(data);
    setState(data.state || null);
    setForm({ enabled: data.enabled, repo: data.repo, branch: data.branch, intervalHours: data.intervalHours, token: "" });
  };

  useEffect(() => {
    load()
      .catch(err => toast.error(errorMessage(err, "版本更新设置读取失败")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (extra = {}) => {
    setSaving(true);
    try {
      const body = { ...form, ...extra };
      if (!body.token) delete body.token;
      const res = await adminApi.put("/update/settings", body);
      const data = payload(res);
      setSettings(data);
      setForm({ enabled: data.enabled, repo: data.repo, branch: data.branch, intervalHours: data.intervalHours, token: "" });
      toast.success("版本更新设置已保存");
    } catch (err) {
      toast.error(errorMessage(err, "版本更新设置保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = await adminApi.post("/update/check");
      const data = payload(res);
      const fresh = payload(await adminApi.get("/update/settings"));
      setState(fresh.state || null);
      if (data.skipped) toast.success(data.reason || "已有检测在进行中");
      else if (data.upToDate) toast.success(`已是最新版本（${data.localVersion}）`);
      else toast.success(`发现新版本 ${data.remoteVersion}${data.notified ? "，已推送通知" : ""}`);
    } catch (err) {
      toast.error(errorMessage(err, "版本检测失败"));
    } finally {
      setChecking(false);
    }
  };

  if (loading) return <div className="page-header"><h1>版本更新</h1><p role="status">正在读取…</p></div>;
  if (!settings || !form) return <div className="page-header"><h1>版本更新</h1><p role="alert">设置读取失败，请刷新重试。</p></div>;

  const status = state?.upToDate === null || state?.upToDate === undefined
    ? "尚未检测"
    : state.upToDate ? "已是最新" : `有新版本 ${state.remoteVersion} 可更新`;

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>版本更新</h1>
          <p>定时比对 GitHub 仓库发布版本与当前运行版本；发现新版本时通过通知推送提醒，更新由人工确认后在服务器执行。</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={checkNow} disabled={checking}>
          {checking ? "检测中…" : "立即检查"}
        </button>
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>检测状态</h2></div>
        <div className="grid-2">
          <Field label="当前运行版本"><p style={{ margin: 0, fontFamily: "monospace" }}>{state?.localVersion || "未知"}</p></Field>
          <Field label="仓库发布版本"><p style={{ margin: 0, fontFamily: "monospace" }}>{state?.remoteVersion || "未检测"}</p></Field>
          <Field label="状态"><p style={{ margin: 0, fontWeight: 600 }}>{status}</p></Field>
          <Field label="上次检查"><p style={{ margin: 0 }}>{fmtTime(state?.lastCheckAt)}</p></Field>
        </div>
        {state?.lastError && <p role="alert" style={{ color: "var(--danger, #c0392b)", marginTop: 12 }}>最近检测失败：{state.lastError}</p>}
      </section>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-title-row"><h2>定时检测设置</h2></div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={event => setForm({ ...form, enabled: event.target.checked })}
          />
          <span>启用定时检测（关闭后仍可点「立即检查」手动检测）</span>
        </label>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <Field label="GitHub 仓库" hint="格式 owner/name">
            <input value={form.repo} onChange={event => setForm({ ...form, repo: event.target.value })} placeholder="owner/name" />
          </Field>
          <Field label="分支">
            <input value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} placeholder="main" />
          </Field>
          <Field label="检测间隔（小时）" hint="1-168">
            <input
              type="number" min={1} max={168}
              value={form.intervalHours}
              onChange={event => setForm({ ...form, intervalHours: event.target.value })}
            />
          </Field>
          <Field label="GitHub Token" hint={settings.tokenSet ? "已保存，留空保持不变" : "可选：公开仓库无需；私有仓库需 Contents:read 只读 PAT"}>
            <input
              type="password"
              value={form.token}
              onChange={event => setForm({ ...form, token: event.target.value })}
              placeholder={settings.tokenSet ? "••••••••" : "github_pat_… 或 ghp_…（可选）"}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button type="button" className="btn btn-primary" onClick={() => save()} disabled={saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
          {settings.tokenSet && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => save({ clear: ["token"] })} disabled={saving}>
              清除已存 Token
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-title-row"><h2>更新流程</h2></div>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>新版本发布到 GitHub 仓库后，检测器按间隔比对 <code>app/VERSION</code> 与运行版本。</li>
          <li>发现新版本时通过「通知推送」的通道发送提醒（事件：新版本可用），每个版本只提醒一次。</li>
          <li>确认发布说明无误后，在服务器执行更新脚本完成构建、切换与健康核验；更新期间会等待录制/上传任务空闲。</li>
        </ol>
      </section>
    </div>
  );
}

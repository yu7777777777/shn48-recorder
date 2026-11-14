import React, { useEffect, useRef, useState } from "react";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "./Toast";
import "./Backup115.css";

const BASE = "/backup115";
const qrLabels = { waiting: "等待使用115 App扫码", scanned: "已扫码，请在115 App确认登录", signed_in: "115登录成功", expired: "二维码已过期，请重新获取", canceled: "扫码登录已取消" };

export default function Backup115Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState({ targetPath: "/48tools归档", autoBackup: false });
  const [connection, setConnection] = useState(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [qr, setQr] = useState(null);
  const [qrStatus, setQrStatus] = useState("");
  const generation = useRef(0);
  const qrRequest = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    adminApi.get(BASE + "/", { signal: controller.signal }).then(response => {
      const data = payload(response, {});
      if (!data?.settings || !data?.connection) return;
      setSettings({ targetPath: data.settings.targetPath || "/48tools归档", autoBackup: Boolean(data.settings.autoBackup) });
      setConnection(data.connection); setAvailable(true);
    }).catch(e => {
      if (!controller.signal.aborted && e?.response?.status !== 404) setError(errorMessage(e, "115设置读取失败"));
    }).finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => { controller.abort(); generation.current++; qrRequest.current?.abort(); };
  }, []);

  // A separate abortable loop: closing/replacing a QR never accepts a late response.
  useEffect(() => {
    if (!qr || !["waiting", "scanned"].includes(qrStatus)) return;
    const controller = new AbortController();
    let timer;
    const deadline = Number.isFinite(Date.parse(qr.expiresAt)) ? Date.parse(qr.expiresAt) : Date.now() + 180000;
    async function poll() {
      if (controller.signal.aborted) return;
      if (Date.now() >= deadline) { setQrStatus("expired"); setError("扫码登录超时，请重新获取二维码"); return; }
      try {
        const data = payload(await adminApi.get(BASE + "/auth/qr/" + encodeURIComponent(qr.sessionId), { signal: controller.signal }), {});
        if (controller.signal.aborted) return;
        if (!Object.hasOwn(qrLabels, data?.status)) throw new Error("无法识别扫码登录状态，请重新获取二维码");
        if (Date.now() >= deadline && data.status !== "signed_in") { setQrStatus("expired"); setError("扫码登录超时，请重新获取二维码"); return; }
        if (data.connection) setConnection(data.connection);
        if (data.status === "signed_in") {
          const connection = data.connection || payload(await adminApi.post(BASE + "/auth/check", {}, { signal: controller.signal }), {});
          if (!controller.signal.aborted) { setConnection(connection); setQrStatus("signed_in"); setQr(null); toast.success("115扫码登录成功"); }
          return;
        }
        setQrStatus(data.status);
        if (["expired", "canceled"].includes(data.status)) { setError(qrLabels[data.status]); return; }
        timer = window.setTimeout(poll, 1800);
      } catch (e) {
        if (!controller.signal.aborted) { setError(errorMessage(e, "扫码状态查询失败，请重新获取二维码")); setQrStatus("error"); }
      }
    }
    timer = window.setTimeout(poll, 800);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [qr, qrStatus, toast]);

  function cancelQr() {
    generation.current++; qrRequest.current?.abort(); setQr(null); setQrStatus("canceled"); setBusy("");
  }
  async function startQr() {
    const id = ++generation.current;
    qrRequest.current?.abort();
    const controller = new AbortController(); qrRequest.current = controller;
    setQr(null); setQrStatus(""); setError(""); setBusy("qr");
    try {
      const data = payload(await adminApi.post(BASE + "/auth/qr", {}, { signal: controller.signal }), {});
      if (id !== generation.current) return;
      if (!data?.sessionId || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(data.qrDataUrl || "")) throw new Error("服务端未返回有效登录二维码");
      setQr(data); setQrStatus("waiting");
    } catch (e) { if (id === generation.current && !controller.signal.aborted) setError(errorMessage(e, "获取二维码失败")); }
    finally { if (id === generation.current) setBusy(""); }
  }
  async function action(kind) {
    setError("");
    if (kind === "logout" || kind === "check") cancelQr();
    setBusy(kind);
    try {
      if (kind === "save") {
        const data = payload(await adminApi.put(BASE + "/settings", { targetPath: settings.targetPath.trim(), autoBackup: settings.autoBackup }), settings);
        setSettings({ targetPath: data.targetPath, autoBackup: Boolean(data.autoBackup) }); toast.success("115备份设置已独立保存");
      } else {
        setConnection(payload(await adminApi.post(BASE + "/auth/" + kind), {}));
        toast.success(kind === "logout" ? "已注销115连接" : "115连接检查完成");
      }
    } catch (e) { const message = errorMessage(e, "115操作失败"); setError(message); toast.error(message); }
    finally { setBusy(""); }
  }

  return <section className="card backup115-settings" aria-labelledby="backup115-settings-title">
    <div className="card-title-row"><div><h2 id="backup115-settings-title">115归档备份</h2><p>独立保存设置与授权，不随页面顶部“保存设置”提交。备份不会自动删除本地文件。</p></div></div>
    <p role="status">{busy === "loading" ? "读取115连接中…" : !available ? "115备份服务尚未启用" : connection?.authorized ? "已授权：" + (connection.accountLabel || "115账号") : "未授权115账号"}</p>
    {connection && <p className="muted">运行时：{connection.runtimeAvailable ? "可用" : "不可用"}{connection.message ? " · " + connection.message : ""}</p>}
    {error && <p className="backup115-error" role="alert">{error}</p>}
    <div className="backup115-actions">
      <button type="button" className="btn btn-secondary" disabled={!available || !connection?.runtimeAvailable || Boolean(busy)} onClick={startQr}>115扫码登录</button>
      <button type="button" className="btn btn-secondary" disabled={!available || Boolean(busy)} onClick={() => action("check")}>检查115连接</button>
      <button type="button" className="btn btn-secondary" disabled={!available || !connection?.authorized || Boolean(busy)} onClick={() => action("logout")}>注销115</button>
      {busy === "qr" && <button type="button" className="btn btn-secondary" onClick={cancelQr}>取消扫码登录</button>}
    </div>
    {qr && <div className="backup115-qr" aria-label="115扫码授权"><img src={qr.qrDataUrl} alt="115登录二维码" /><div><p role="status">{qrLabels[qrStatus] || "扫码查询失败"}</p><p className="muted">请在115 App扫码确认，无需粘贴Cookie。二维码有效期内请完成确认。</p><button type="button" className="btn btn-secondary" onClick={cancelQr}>取消扫码登录</button></div></div>}
    <div className="form-group"><label htmlFor="backup115-target">115备份根目录</label><input id="backup115-target" value={settings.targetPath || ""} disabled={!available || Boolean(busy)} onChange={e => setSettings(s => ({ ...s, targetPath: e.target.value }))} placeholder="/48tools归档" /></div>
    <label className="backup115-toggle"><input type="checkbox" checked={settings.autoBackup} disabled={!available || Boolean(busy)} onChange={e => setSettings(s => ({ ...s, autoBackup: e.target.checked }))} />新归档自动备份到115（不批量补传历史归档）</label>
    <button type="button" className="btn btn-primary" disabled={!available || Boolean(busy) || !settings.targetPath?.trim().startsWith("/")} onClick={() => action("save")}>{busy === "save" ? "保存中…" : "保存115备份设置"}</button>
  </section>;
}

import React, { useCallback, useMemo, useRef, useState } from "react";
import usePolling from "../hooks/usePolling";
import { Link } from "react-router-dom";
import { StatusBadge } from "../components/Badge";
import ConfirmModal from "../components/ConfirmModal";
import EmptyState from "../components/EmptyState";
import {
  IconAlertCircle,
  IconBilibili,
  IconClock,
  IconExternalLink,
  IconLogOut,
  IconQrCode,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconUser,
  IconX,
} from "../components/Icons";
import ProgressBar from "../components/ProgressBar";
import SafeImage from "../components/SafeImage";
import CoverPicker from "../components/CoverPicker";
import { useToast } from "../components/Toast";
import { adminApi, errorMessage, listPayload, payload } from "../lib/api";

const statusText = {
  queued: "等待上传",
  uploading: "上传中",
  paused_recording: "录制中暂停上传",
  done: "已完成",
  draft: "已存草稿",
  failed: "上传失败",
  pending: "等待中",
};

function formatDate(value, seconds = false) {
  if (!value) return "—";
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const raw =
    seconds || (typeof numeric === "number" && numeric < 10_000_000_000)
      ? Number(numeric) * 1000
      : numeric;
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeAccount(value) {
  const source = value?.account || value || {};
  const profile = source.profile || source.user || source.info || {};
  const healthValue = String(source.health || source.status || "").toLowerCase();
  const authenticated = Boolean(
    source.authenticated ?? source.loggedIn ?? source.isLogin ?? profile.authenticated
  );
  const credentialsPresent = Boolean(source.credentialsPresent ?? authenticated);
  const explicitHealth =
    source.loginHealthy ?? source.healthy ?? source.valid ?? profile.loginHealthy;
  const level =
    source.currentLevel ??
    source.level ??
    profile.currentLevel ??
    profile.level ??
    profile.levelInfo?.current_level ??
    profile.level_info?.current_level;
  const vipStatus =
    source.vipStatus ?? profile.vipStatus ?? profile.vip?.status ?? profile.vip?.type;
  const health =
    healthValue === "unavailable"
      ? "unavailable"
      : healthValue === "credentials_error"
      ? "credentials_error"
      : healthValue === "not_logged_in"
      ? "offline"
      : healthValue === "ok"
      ? "healthy"
      : !authenticated
      ? "offline"
      : explicitHealth === true
      ? "healthy"
      : explicitHealth === false
      ? "invalid"
      : "unverified";
  return {
    authenticated,
    credentialsPresent,
    status: healthValue,
    upstreamAvailable: source.upstreamAvailable ?? null,
    stale: Boolean(source.stale),
    uid: String(source.uid ?? source.mid ?? profile.uid ?? profile.mid ?? profile.id ?? ""),
    uname:
      source.uname ||
      source.name ||
      source.nickname ||
      profile.uname ||
      profile.name ||
      profile.nickname ||
      "",
    face: source.face || source.avatar || profile.face || profile.avatar || "",
    level: level === undefined || level === null || level === "" ? null : level,
    vipStatus,
    vipType: source.vipType ?? profile.vipType ?? profile.vip?.type ?? null,
    lastCheckedAt:
      source.lastCheckedAt ||
      source.lastVerifiedAt ||
      source.checkedAt ||
      profile.lastCheckedAt ||
      null,
    lastSuccessfulAt: source.lastSuccessfulAt || profile.lastSuccessfulAt || null,
    health,
  };
}

function responseSummary(response) {
  const summary = response?.data?.summary;
  return summary && typeof summary === "object" ? summary : {};
}

function safeCount(value, fallback) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : fallback;
}

function QueueTable({ items }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>录像名称</th>
            <th>状态</th>
            <th>上传进度</th>
            <th>加入时间</th>
            <th>完成时间</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td><strong style={{ color: "var(--text-main)" }}>{item.title || item.recordingName || item.id}</strong></td>
              <td><StatusBadge status={item.status}>{statusText[item.status] || item.status}</StatusBadge></td>
              <td style={{ minWidth: "160px" }}>
                <ProgressBar
                  percent={item.progress || (item.status === "done" ? 100 : 0)}
                  tone={item.status === "failed" ? "danger" : "primary"}
                  height={6}
                  showLabel
                />
              </td>
              <td>{formatDate(item.addedAt || item.createdAt)}</td>
              <td>{formatDate(item.completedAt || item.failedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BilibiliPage() {
  const [coverTarget, setCoverTarget] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [draftState, setDraftState] = useState("loading");
  const [draftTotal, setDraftTotal] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueSummary, setQueueSummary] = useState(null);
  const [accountRaw, setAccountRaw] = useState(null);
  const [qr, setQr] = useState(null);
  const [qrStatus, setQrStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const deletingRef = useRef(false);
  const draftRequestRef = useRef(0);
  const qrRunRef = useRef(0);
  const toast = useToast();

  const account = useMemo(() => normalizeAccount(accountRaw), [accountRaw]);
  const pendingUploads = queue.filter((item) => item.status !== "done");
  const completedUploads = queue
    .filter((item) => item.status === "done")
    .sort((a, b) => Date.parse(b.completedAt || b.addedAt || 0) - Date.parse(a.completedAt || a.addedAt || 0));

  const loadData = useCallback(async () => {
    const requestId = ++draftRequestRef.current;
    const results = await Promise.allSettled([
      adminApi.get("/bilibili/drafts"),
      adminApi.get("/bilibili/queue"),
      adminApi.get("/bilibili/account"),
    ]);
    if (requestId !== draftRequestRef.current) return;
    if (results[0].status === "fulfilled") {
      const items = listPayload(results[0].value, ["drafts", "items", "archives"]);
      setDrafts(items);
      setDraftTotal(safeCount(responseSummary(results[0].value).total, items.length));
      setDraftState("ready");
    } else {
      setDraftTotal(null);
      setDraftState("error");
    }
    if (results[1].status === "fulfilled") {
      const items = listPayload(results[1].value, ["queue", "items"]);
      const summary = responseSummary(results[1].value);
      setQueue(items);
      setQueueSummary({
        total: safeCount(summary.total, items.length),
        queued: safeCount(
          summary.queued,
          items.filter((item) => ["queued", "pending"].includes(item.status)).length
        ),
        uploading: safeCount(
          summary.uploading,
          items.filter((item) => item.status === "uploading").length
        ),
        failed: safeCount(
          summary.failed,
          items.filter((item) => item.status === "failed").length
        ),
        done: safeCount(
          summary.done,
          items.filter((item) => item.status === "done").length
        ),
      });
    }
    if (results[2].status === "fulfilled") {
      const nextAccount = payload(results[2].value, null);
      setAccountRaw(nextAccount);
      if (normalizeAccount(nextAccount).status === "not_logged_in") setDrafts([]);
    }
  }, []);

  usePolling(loadData, 15000);

  async function startQrLogin() {
    const runId = ++qrRunRef.current;
    setQr(null);
    setQrStatus("正在生成登录二维码…");
    try {
      const res = await adminApi.post("/bilibili/login/qrcode/start");
      if (runId !== qrRunRef.current) return;
      const data = payload(res, {});
      setQr(data);
      setQrStatus("请使用手机哔哩哔哩 App 扫码登录");
      pollQrStatus(data.oauthKey || data.key, runId);
    } catch (err) {
      if (runId === qrRunRef.current) {
        setQrStatus("二维码获取失败，请重试");
        toast.error(errorMessage(err, "获取二维码失败"));
      }
    }
  }

  async function pollQrStatus(key, runId) {
    if (!key) return;
    const interval = setInterval(async () => {
      if (runId !== qrRunRef.current) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await adminApi.get("/bilibili/login/qrcode/status", {
          params: { oauthKey: key, key },
        });
        const data = payload(res, {});
        const code = data.code ?? data.status;
        if (code === 0 || code === "success") {
          clearInterval(interval);
          setQr(null);
          setQrStatus("");
          toast.success("B站账号登录成功！");
          await loadData();
        } else if (code === 86038 || code === "expired") {
          clearInterval(interval);
          setQrStatus("二维码已过期，请重新获取");
        } else if (code === 86090 || code === "scanned") {
          setQrStatus("已扫码，请在手机上点击确认登录");
        }
      } catch {
        // quiet error on poll
      }
    }, 2500);
  }

  function closeQr() {
    qrRunRef.current += 1;
    setQr(null);
    setQrStatus("");
  }

  async function logoutBili() {
    setBusy("logout");
    try {
      await adminApi.post("/bilibili/account/logout");
      toast.success("已退出 B站账号");
      setConfirmLogout(false);
      await loadData();
    } catch (err) {
      toast.error(errorMessage(err, "退出登录失败"));
    } finally {
      setBusy("");
    }
  }

  async function deleteSelectedDraft() {
    if (!deleteTarget?.draftId || deletingRef.current) return;
    deletingRef.current = true;
    setBusy("delete-draft");
    try {
      await adminApi.delete(`/bilibili/draft/${encodeURIComponent(deleteTarget.draftId)}`, {
        data: { confirmed: true }, timeout: 30000,
      });
      ++draftRequestRef.current;
      setDrafts((items) => items.filter((item) => item.draftId !== deleteTarget.draftId));
      setDraftTotal((total) => total === null ? null : Math.max(0, total - 1));
      setDeleteTarget(null);
      toast.success("已删除 B站草稿，服务器录像已保留");
      await loadData();
    } catch (error) {
      toast.error(errorMessage(error, "删除结果未确认，请刷新列表后检查"));
    } finally {
      deletingRef.current = false;
      setBusy("");
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <span className="eyebrow">BILIBILI STUDIO</span>
          <h1>B站草稿中枢</h1>
          <p>管理绑定的 B站账号、实时监视上传切片队列，并检查已入库的草稿箱状态。</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={loadData}
        >
          <IconRefresh size={13} />
          <span>刷新状态</span>
        </button>
      </div>

      {/* Account Info Strip */}
      <section className="card bili-account-card" style={{ marginBottom: "24px" }}>
        <div className="bili-account-strip">
          <div className="bili-identity">
            <div className="bili-avatar">
              <SafeImage
                src={account.face}
                fallback={
                  <div className="cover-placeholder" style={{ borderRadius: "50%" }}>
                    <IconUser size={24} />
                  </div>
                }
              />
            </div>
            <div className="bili-details">
              <div className="bili-name-row">
                <strong>{account.uname || (account.authenticated ? "B站用户" : "未登录账号")}</strong>
                {account.level !== null && (
                  <span className="badge badge-queued" style={{ fontSize: "10px", padding: "1px 6px" }}>
                    LV{account.level}
                  </span>
                )}
                {account.vipStatus && (
                  <span className="badge" style={{ background: "rgba(251, 114, 153, 0.2)", color: "#fb7299", fontSize: "10px" }}>
                    大会员
                  </span>
                )}
              </div>
              <span>
                {account.authenticated
                  ? `UID: ${account.uid} · 凭据有效`
                  : "绑定 B站账号后，录像归档即可一键上传至草稿箱"}
              </span>
            </div>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <StatusBadge status={account.health}>
                {account.health === "healthy"
                  ? "账号正常"
                  : account.health === "offline"
                  ? "未绑定 / 离线"
                  : account.health}
              </StatusBadge>
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "4px" }} title="只检查 B站登录凭据是否有效，不会重复上传录像">
              最近登录状态检查：{formatDate(account.lastCheckedAt)}
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            {account.authenticated ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmLogout(true)}
                disabled={busy === "logout"}
              >
                <IconLogOut size={13} />
                <span>退出绑定</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={startQrLogin}
              >
                <IconQrCode size={15} />
                <span>扫码绑定 B站账号</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Upload Queue Section */}
      <section className="card" style={{ marginBottom: "24px" }}>
        <div className="card-title-row">
          <div>
            <h2>上传状态</h2>
            <p>待处理和失败任务显示在这里；已完成记录收在下方历史中</p>
          </div>
          {queueSummary && (
            <div style={{ display: "flex", gap: "8px" }}>
              <span className="badge badge-queued">{queueSummary.queued} 排队中</span>
              <span className="badge badge-done">{queueSummary.uploading} 上传中</span>
            </div>
          )}
        </div>

        {pendingUploads.length > 0 ? (
          <QueueTable items={pendingUploads} />
        ) : (
          <EmptyState
            icon={IconUpload}
            title="当前没有待处理的上传"
            detail="已完成的上传收在下方历史中；新录像可在「录像归档」中送入 B站草稿。"
          />
        )}
        {completedUploads.length > 0 && (
          <details className="bili-upload-history">
            <summary>已完成历史（{completedUploads.length} 条）<span>展开查看</span></summary>
            <p>这里是上传记录，用于防止同一录像重复上传及关联 B站草稿。</p>
            <QueueTable items={completedUploads} />
          </details>
        )}
      </section>

      {/* Drafts List Section */}
      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>B站草稿箱 ({draftTotal ?? drafts.length} 篇)</h2>
            <p>可直接删除 B站草稿，服务器录像与上传历史会保留；编辑和发布请前往 B站创作中心</p>
          </div>
          <a
            className="btn btn-secondary btn-sm"
            href="https://member.bilibili.com/platform/upload-manager/article"
            target="_blank"
            rel="noreferrer"
          >
            <span>前往 B站创作中心</span>
            <IconExternalLink size={13} />
          </a>
        </div>

        {draftState === "loading" ? (
          <div className="state-card">
            <span className="spinner" />
            <span>正在获取草稿箱列表…</span>
          </div>
        ) : draftState === "error" ? (
          <EmptyState icon={IconAlertCircle} title="草稿列表暂时无法获取" detail="请刷新状态后重试，当前不会显示未经核实的草稿。" />
        ) : drafts.length > 0 ? (
          <div className="public-live-grid">
            {drafts.map((d, index) => (
              <div
                key={d.draftId || d.bvid || d.aid || index}
                className="public-live-card"
                style={{ cursor: "default" }}
              >
                <div className="live-cover">
                  <SafeImage
                    src={d.cover}
                    alt={`${d.title || "直播回放"}封面`}
                    fallback={
                      <div className="cover-placeholder">
                        <IconBilibili size={32} />
                      </div>
                    }
                  />
                  {d.durationSeconds > 0 && <span className="draft-duration">{Math.floor(d.durationSeconds / 60)}:{String(Math.floor(d.durationSeconds % 60)).padStart(2, "0")}</span>}
                  <span className="badge badge-draft" style={{ position: "absolute", top: "10px", left: "10px" }}>
                    草稿
                  </span>
                  {Number(d.liveType) === 2 && <span className="badge badge-radio-live" style={{ position: "absolute", top: "10px", right: "10px" }}>
                    电台直播
                  </span>}
                </div>
                <div className="live-card-body" style={{ gridTemplateColumns: "1fr auto" }}>
                  <div className="live-copy">
                    <strong>{d.title || "未命名草稿"}</strong>
                    <span>
                      草稿 · {formatDate(d.updatedAt || d.createdAt || d.mtime || d.ctime)}
                    </span>
                  </div>
                  <div className="draft-card-actions">
                  {d.recordingId && <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={async () => {
                    try { setCoverTarget(payload(await adminApi.get(`/recordings/${encodeURIComponent(d.recordingId)}`))); }
                    catch (error) { toast.error(errorMessage(error, "关联录像获取失败")); }
                  }}>选择封面{d.coverSyncPending ? " · 待同步" : ""}</button>}
                  <a
                    className="btn btn-secondary btn-sm"
                    href={`https://member.bilibili.com/platform/upload-manager/article`}
                    target="_blank"
                    rel="noreferrer"
                    title="在B站打开"
                  >
                    <IconExternalLink size={13} />
                  </a>
                  <button type="button" className="btn btn-danger btn-sm"
                    aria-label={`删除草稿：${d.title || "未命名草稿"}`}
                    title={d.draftId ? "删除 B站草稿，保留服务器录像" : "缺少草稿 ID，无法安全删除"}
                    disabled={!/^[1-9]\d{0,15}$/.test(d.draftId || "") || Boolean(busy)}
                    onClick={() => setDeleteTarget(d)}>
                    <IconTrash size={13} /><span>删除</span>
                  </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={IconBilibili}
            title="草稿箱暂无内容"
            detail="上传完成后的视频会保存在 B站草稿箱中。"
          />
        )}
      </section>

      {coverTarget && <CoverPicker recording={coverTarget} onClose={() => setCoverTarget(null)} onSaved={loadData} />}
      {/* QR Code Login Modal */}
      {qr && (
        <div className="modal-backdrop" onClick={closeQr}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "380px" }}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <span className="modal-icon-badge primary">
                  <IconBilibili size={18} />
                </span>
                <h3>B站扫码登录</h3>
              </div>
              <button type="button" className="modal-close-btn" onClick={closeQr}>
                <IconX size={16} />
              </button>
            </div>
            <div className="bili-qr-box">
              <div className="bili-qr-img">
                <img src={qr.url || qr.qrcode} alt="B站登录二维码" />
              </div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-main)" }}>
                {qrStatus}
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-dim)" }}>
                请打开「哔哩哔哩手机客户端」右上角扫一扫
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeQr}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={startQrLogin}>
                <IconRefresh size={13} /> 重新获取
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logout Confirm Modal */}
      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="删除这条 B站草稿？"
        description={<><p className="draft-delete-title">{deleteTarget?.title || "未命名草稿"}</p><p>确认后将从 B站草稿箱永久删除，无法撤销。服务器录像和上传历史会保留，不会自动重新上传。</p></>}
        confirmText="确认删除草稿"
        confirmType="danger"
        isLoading={busy === "delete-draft"}
        onConfirm={deleteSelectedDraft}
        onCancel={() => { if (!deletingRef.current) setDeleteTarget(null); }}
      />
      <ConfirmModal
        isOpen={confirmLogout}
        title="确认退出 B站账号？"
        description="退出登录后，系统将清除本地保存的登录凭据，无法自动将录像推送到 B站草稿箱。"
        confirmText="确认退出"
        cancelText="取消"
        confirmType="danger"
        isLoading={busy === "logout"}
        onConfirm={logoutBili}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}

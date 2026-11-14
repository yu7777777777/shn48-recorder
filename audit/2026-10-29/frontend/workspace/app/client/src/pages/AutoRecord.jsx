import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { StatusBadge, TeamBadge } from "../components/Badge";
import EmptyState from "../components/EmptyState";
import {
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSmartphone,
  IconUser,
  IconUsers,
  IconX,
} from "../components/Icons";
import SafeImage from "../components/SafeImage";
import LoadingState from "../components/LoadingState";
import { useToast } from "../components/Toast";
import { adminApi, errorMessage, listPayload, payload } from "../lib/api";

export function normalizeMember(item = {}) {
  const user = item.userInfo || item.member || item.user || item;
  const groupId = String(user.groupId ?? item.groupId ?? "");
  return {
    id: String(user.userId ?? user.memberId ?? user.id ?? ""),
    name: user.nickname || user.name || user.userName || user.memberName || item.memberName || "未命名成员",
    avatar: user.avatar || user.avatarUrl || user.cover || "",
    groupId,
    groupIds: (user.groupIds || item.groupIds || [groupId]).map(String).filter(Boolean),
    groupName: user.groupName || item.groupName || "",
  };
}

export function filterMembers(members, query, groupId, organizationId = "") {
  const q = query.trim().toLowerCase();
  return members.filter(
    (member) =>
      (!organizationId || member.groupIds.some((id) => id.startsWith(`${organizationId}:`))) &&
      (!groupId || member.groupIds.includes(groupId)) &&
      (!q || member.name.toLowerCase().includes(q) || member.id.includes(q))
  );
}

const labels = { 1: "高", 50: "普通", 100: "低" };

export default function AutoRecordPage() {
  const [config, setConfig] = useState({ enabled: false, members: [], maxConcurrent: 2 });
  const [members, setMembers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [query, setQuery] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [status, setStatus] = useState({});
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [busy, setBusy] = useState(false);
  const [memberState, setMemberState] = useState("loading");
  const [showLogin, setShowLogin] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('login') === '1');
  const [loginMode, setLoginMode] = useState("sms");
  const [login, setLogin] = useState({ mobile: "", code: "", token: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsCooldown, setSmsCooldown] = useState(0);
  const [smsChallenge, setSmsChallenge] = useState(null);
  const [challengeAnswer, setChallengeAnswer] = useState("");
  const [account, setAccount] = useState(null);
  const memberScrollTop = useRef(null);
  const toast = useToast();

  const notify = useCallback((text, type = "info") => {
    setMessage(text);
    setMessageType(type);
  }, []);

  const closeLogin = () => {
    if (loginBusy || smsBusy) return;
    setShowLogin(false);
    setLoginError("");
    setLogin((val) => ({ ...val, code: "", token: "", password: "" }));
    setSmsChallenge(null);
    setChallengeAnswer("");
  };

  const load = useCallback(
    async ({ refresh = false, announce = false } = {}) => {
      setMemberState("loading");
      try {
        const [configResponse, rosterResponse] = await Promise.all([
          adminApi.get("/pocket48/auto-recording"),
          adminApi.get("/pocket48/members", { params: refresh ? { refresh: "1" } : {} }),
        ]);
        const nextStatus = payload(configResponse, {});
        const rosterData = payload(rosterResponse, {});
        const nextGroups = Array.isArray(rosterData.groups) ? rosterData.groups : [];
        const all = listPayload(rosterResponse, ["list", "members", "memberList", "items"])
          .map(normalizeMember)
          .filter((member) => member.id);
        setGroups(nextGroups);
        setConfig((val) => ({ ...val, ...nextStatus }));
        setStatus(nextStatus);
        setMembers([...new Map(all.map((m) => [m.id, m])).values()]);
        setMemberState(all.length ? "ready" : "empty");
      } catch (err) {
        const message = errorMessage(err, "成员名单加载失败，请稍后重试");
        setMemberState("error");
        // The page keeps failed loads on screen; only a user-triggered refresh
        // raises a toast so a failing upstream cannot spam identical popups.
        if (announce) notify(message, "error");
      }
    },
    [notify]
  );

  useEffect(() => {
    load();
    adminApi
      .get("/pocket48/auth/status")
      .then((res) => setAccount(payload(res, null)))
      .catch(() => setAccount({ authenticated: false }));
  }, [load]);

  useEffect(() => {
    if (smsCooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setSmsCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [smsCooldown]);

  useLayoutEffect(() => {
    if (memberScrollTop.current === null) return;
    const scroller = document.querySelector(".admin-main");
    if (scroller) scroller.scrollTop = memberScrollTop.current;
    memberScrollTop.current = null;
  }, [config.members]);

  const organizations = useMemo(
    () => [
      ...new Map(
        groups
          .map((g) => {
            const id = String(g.groupId || g.id || "").split(":", 1)[0];
            const name = String(g.groupName || g.name || "").split(" · ", 1)[0];
            return [id, { id, name }];
          })
          .filter(([id]) => id)
      ).values(),
    ],
    [groups]
  );

  const teamGroups = useMemo(
    () =>
      organizationId
        ? groups.filter((g) => String(g.groupId || g.id || "").startsWith(`${organizationId}:`))
        : [],
    [groups, organizationId]
  );

  const visible = useMemo(
    () => filterMembers(members, query, groupId, organizationId),
    [members, query, groupId, organizationId]
  );

  const selected = (config.members || []).filter((item) => item.enabled !== false);
  const selectedIds = new Set(selected.map((item) => String(item.memberId)));
  // Server-reported free space for the recordings volume. Undefined on an older
  // backend, so the card is hidden rather than rendering a bogus 0 GiB.
  const recordingStatus = status.recordingStatus || null;
  const authenticated = account?.authenticated === true && account?.health === "ok";
  const credentialsInvalid = account?.credentialsPresent === true && account?.health === "invalid";
  const authUnavailable = account?.credentialsPresent === true && account?.health === "unavailable";

  const rememberMemberScroll = () => {
    const scroller = document.querySelector(".admin-main");
    memberScrollTop.current = scroller ? scroller.scrollTop : null;
  };

  const toggle = (id, member) => {
    if (memberScrollTop.current === null) rememberMemberScroll();
    setConfig((current) => ({
      ...current,
      members: (current.members || []).some((item) => String(item.memberId) === id)
        ? current.members.map((item) =>
            String(item.memberId) === id ? { ...item, enabled: !item.enabled } : item
          )
        : [
            ...(current.members || []),
            {
              memberId: id,
              memberName: member?.name || id,
              priority: 50,
              enabled: true,
            },
          ],
    }));
  };

  function updatePriority(id, priority) {
    setConfig((current) => ({
      ...current,
      members: (current.members || []).map((item) =>
        String(item.memberId) === id ? { ...item, priority: Number(priority) } : item
      ),
    }));
  }

  function addManual() {
    const id = manualId.trim();
    if (!id) {
      notify("请输入成员 ID", "error");
      return toast.error("请输入成员 ID");
    }
    if ((config.members || []).some((item) => String(item.memberId) === id)) {
      notify("该成员已在监控列表", "error");
      return toast.error("该成员已在监控列表");
    }
    setConfig((current) => ({
      ...current,
      members: [
        ...(current.members || []),
        { memberId: id, memberName: manualName.trim() || id, priority: 50, enabled: true },
      ],
    }));
    setManualId("");
    setManualName("");
    notify("已添加成员，可设置优先级", "success");
    toast.success("已添加成员到监控列表");
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await adminApi.put("/pocket48/auto-recording", config);
      notify("自动录制配置已保存", "success");
      toast.success("自动录制配置已保存");
    } catch (error) {
      notify(errorMessage(error, "保存失败"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendSms() {
    const mobile = login.mobile.trim();
    if (!/^1\d{10}$/.test(mobile)) return setLoginError("请输入有效的 11 位手机号");
    if (smsChallenge && !challengeAnswer) return setLoginError("请先选择安全验证答案");
    setSmsBusy(true);
    setLoginError("");
    try {
      const res = await adminApi.post("/pocket48/login/sms/send", {
        mobile,
        ...(challengeAnswer ? { answer: challengeAnswer } : {}),
      });
      const data = payload(res, {});
      setSmsChallenge(null);
      setChallengeAnswer("");
      setSmsCooldown(60);
      toast.success("短信验证码已发送，请查收");
    } catch (err) {
      const data = err?.response?.data || {};
      if (data?.challenge) {
        setSmsChallenge(data.challenge);
        setLoginError("请完成图形/安全验证后再次发送");
      } else {
        setLoginError(errorMessage(err, "短信验证码发送失败"));
      }
    } finally {
      setSmsBusy(false);
    }
  }

  async function submitLogin(e) {
    e.preventDefault();
    if (loginBusy || smsBusy) return;
    if (loginMode !== 'token' && !/^1\d{10}$/.test(login.mobile.trim())) return setLoginError("请输入有效的 11 位手机号");
    if (loginMode === 'sms' && !/^\d{4,8}$/.test(login.code.trim())) return setLoginError("请输入有效短信验证码");
    if (loginMode === 'password' && !login.password) return setLoginError('请输入口袋48账号密码');
    if (loginMode === 'token' && (!login.token.trim() || /\s/.test(login.token.trim()))) return setLoginError('请输入有效的访问凭据 Token');
    setLoginBusy(true);
    setLoginError("");
    try {
      const endpoint = loginMode === 'sms' ? '/pocket48/login/sms/verify' : loginMode === 'password' ? '/pocket48/login' : '/pocket48/token';
      const body = loginMode === 'sms' ? { mobile: login.mobile.trim(), code: login.code.trim() }
        : loginMode === 'password' ? { mobile: login.mobile.trim(), password: login.password } : { token: login.token.trim() };
      const res = await adminApi.post(endpoint, body);
      setAccount(payload(res, { authenticated: true }));
      toast.success("口袋48账号登录成功");
      setShowLogin(false);
      setLogin(val => ({ ...val, code: '', password: '', token: '' }));
      setSmsChallenge(null);
      setChallengeAnswer('');
    } catch (err) {
      setLoginError(errorMessage(err, "登录失败，请检查登录信息或换一种方式"));
    } finally {
      setLoginBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <span className="eyebrow">AUTOMATION</span>
          <h1>自动录制</h1>
          <p>配置监控名单与并发策略，成员开播后系统将自动启动后台录制并存为 B站草稿。</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={busy}
        >
          {busy ? "保存中…" : "保存自动录制配置"}
        </button>
      </div>

      {message && <div className={`admin-alert ${messageType}`}>{message}</div>}
      <p style={{ marginBottom: 16 }}><a href="/admin/pocket48">进入口袋48：个人资料、每日签到与房间消息 →</a></p>

      {!authenticated && !credentialsInvalid && !authUnavailable && (
        <div className="admin-alert info">
          <span>自动录制、公开直播和成员名单均不依赖口袋48登录；登录仅用于需要账号权限的功能。</span>
        </div>
      )}

      {config.maxConcurrent >= 5 && (
        <div className="admin-alert warning">
          <span>当前并发路数较高 ({config.maxConcurrent} 路)，请确保服务器具备足够的带宽与 CPU 性能。</span>
        </div>
      )}

      {/* A live that was discovered but refused must say so here. Without this the
          page looked identical to "nobody is streaming" and an evening of lives
          went missing with no visible cause. */}
      {config.enabled && status.blocked && (
        <div className="admin-alert error">
          <span>
            {status.blocked.message}
            {status.blocked.reason === "disk_space" && status.blocked.freeGiB !== undefined && (
              <>
                {" "}（当前可用 {status.blocked.freeGiB} GiB，本次需要 {status.blocked.requiredGiB} GiB）
              </>
            )}
            {status.blocked.waiting > 0 && <>，共有 {status.blocked.waiting} 场直播在等待</>}
          </span>
        </div>
      )}

      {config.enabled && status.capacityRefused && !status.blocked && (
        <div className="admin-alert info">
          <span>
            {status.capacityRefused.message}（已录 {status.activeCount || 0} / 上限 {config.maxConcurrent} 路）
          </span>
        </div>
      )}

      {/* Pocket48 Account Status Strip */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "12px",
                background: "var(--accent-soft)",
                color: "var(--accent-hover)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconSmartphone size={22} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ fontSize: "15px", fontWeight: 700 }}>口袋48 账号绑定状态</h3>
                <StatusBadge status={authenticated ? "healthy" : "warning"}>
                  {authenticated ? "已登录" : credentialsInvalid ? "凭据失效" : authUnavailable ? "验证不可用" : "游客模式"}
                </StatusBadge>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                {authenticated
                  ? `账号已验证 · 自动录制仍使用公开直播数据，不受账号状态影响`
                  : credentialsInvalid
                    ? "保存的登录凭据已被口袋48拒绝；这不影响自动录制，重新登录可恢复账号功能"
                    : authUnavailable
                      ? "暂时无法验证已保存的账号；自动录制不受影响，可稍后刷新确认"
                      : "自动录制和公开直播可直接使用；登录仅用于需要账号权限的功能"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowLogin(true)}
          >
            <IconUser size={15} />
            <span>{authenticated ? "切换账号" : credentialsInvalid ? "重新登录" : "登录口袋48账号"}</span>
          </button>
        </div>
      </section>

      {/* Global Config Settings Card */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div className="card-title-row">
          <div>
            <h2>监控全局配置</h2>
            <p>设置自动录制主开关及最大同时录制路数（1–20 场）</p>
          </div>
        </div>

        <div className="grid-2" style={{ alignItems: "center" }}>
          <label className="toggle-row">
            <div>
              <strong>启用全局自动录制</strong>
              <small>开启后后台将按监控列表自动发现并录制开播</small>
            </div>
            <input
              type="checkbox"
              style={{ width: "20px", height: "20px", accentColor: "var(--accent)" }}
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
            />
          </label>

          <div style={{ padding: "12px 18px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700 }}>同时最大录制路数</span>
              <span style={{ fontSize: "13px", fontWeight: 800, color: "var(--accent-hover)" }}>
                {config.maxConcurrent || 2} 场
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              value={config.maxConcurrent || 2}
              onChange={(e) => setConfig((c) => ({ ...c, maxConcurrent: Number(e.target.value) }))}
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--text-dim)", marginTop: "4px" }}>
              <span>1 场 (低配)</span>
              <span>10 场</span>
              <span>20 场 (满载)</span>
            </div>
          </div>

          {/* Always visible, not only when a start is refused: the space floor
              used to fail silently, so the operator had no way to see it coming. */}
          {recordingStatus && (
            <div style={{ padding: "12px 18px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700 }}>录像磁盘可用空间</span>
                <span style={{ fontSize: "13px", fontWeight: 800, color: recordingStatus.hasSpace ? "var(--accent-hover)" : "var(--danger, #e5484d)" }}>
                  {recordingStatus.freeGiB === null ? "无法读取" : `${recordingStatus.freeGiB} GiB`}
                </span>
              </div>
              <small style={{ color: "var(--text-muted)" }}>
                按实测码率 {recordingStatus.bytesPerHourGiB ?? "?"} GiB/小时、估算 {recordingStatus.assumedLiveHours} 小时，本次开播约需 {recordingStatus.requiredGiB ?? "?"} GiB；
                空间不足时先自动清理片段与缓存，仍不够才拒绝并告警
                {recordingStatus.freeGiB !== null && !recordingStatus.hasSpace && " — 请尽快清理磁盘"}
              </small>
            </div>
          )}
        </div>
      </section>

      {/* Member Selection Panel */}
      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>监控成员名单 (共 {members.length} 位现役成员，{selected.length} 人已选)</h2>
            <p>点击成员卡片即可加入或移出监控；可随时调节录制优先级</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => load({ refresh: true, announce: true })}
          >
            <IconRefresh size={13} />
            <span>刷新名单</span>
          </button>
        </div>

        {/* Filter Controls */}
        <div className="replay-filter-bar" style={{ marginBottom: "16px" }}>
          <div className="group-tabs-list">
            <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 700, marginRight: "4px" }}>
              团体筛选：
            </span>
            <button
              type="button"
              className={`group-tab-btn ${organizationId === "" ? "active" : ""}`}
              onClick={() => {
                setOrganizationId("");
                setGroupId("");
              }}
            >
              全部组织
            </button>
            {organizations.map((org) => (
              <button
                key={org.id}
                type="button"
                className={`group-tab-btn ${organizationId === org.id ? "active" : ""}`}
                onClick={() => {
                  setOrganizationId(org.id);
                  setGroupId("");
                }}
              >
                {org.name}
              </button>
            ))}
          </div>

          <div className="team-select-shell">
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">{organizationId ? "全部队伍" : "请先选择团体"}</option>
              {teamGroups.map((tg) => (
                <option key={tg.groupId || tg.id} value={tg.groupId || tg.id}>
                  {tg.groupName || tg.name}
                </option>
              ))}
            </select>
          </div>

          <div className="search-input-shell" style={{ maxWidth: "260px" }}>
            <IconSearch size={14} />
            <input
              type="text"
              placeholder="搜索成员姓名或 ID…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Member Grid */}
        {memberState === "loading" ? (
          <LoadingState text="正在获取成员名单…" />
        ) : visible.length > 0 ? (
          <div className="member-cards-container">
            {visible.map((m) => {
              const isSelected = selectedIds.has(m.id);
              const configItem = (config.members || []).find(
                (item) => String(item.memberId) === m.id
              );
              return (
                <div
                  key={m.id}
                  className={`member-select-card ${isSelected ? "selected" : ""}`}
                  onPointerDown={rememberMemberScroll}
                  onClick={() => toggle(m.id, m)}
                >
                  <div className="member-avatar small">
                    <SafeImage
                      src={m.avatar}
                      fallback={<span>{m.name.slice(0, 1)}</span>}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{m.name}</strong>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" }}>
                      <TeamBadge name={m.groupName?.split(" · ")[1] || m.groupName} />
                    </div>
                  </div>
                  {isSelected && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
                    >
                      <select
                        style={{
                          fontSize: "10px",
                          padding: "2px 4px",
                          background: "var(--bg-panel)",
                          color: "var(--accent-hover)",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                        }}
                        value={configItem?.priority ?? 50}
                        onChange={(e) => updatePriority(m.id, e.target.value)}
                      >
                        <option value={1}>高优</option>
                        <option value={50}>普通</option>
                        <option value={100}>低优</option>
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={IconUsers}
            title="未找到匹配的成员"
            detail="换个关键词或选择全部队伍重试。"
          />
        )}

        {/* Manual Add Member Details */}
        <details className="manual-member-details" style={{ marginTop: "20px" }}>
          <summary style={{ cursor: "pointer", fontSize: "13px", fontWeight: 700, color: "var(--accent-hover)", userSelect: "none" }}>
            手动添加成员 ID（高级模式）
          </summary>
          <div
            style={{
              marginTop: "12px",
              padding: "16px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius)",
              display: "flex",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <input
              style={{ width: "160px", padding: "6px 10px", fontSize: "12px" }}
              placeholder="成员 ID"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
            />
            <input
              style={{ width: "160px", padding: "6px 10px", fontSize: "12px" }}
              placeholder="备注姓名 (可选)"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={addManual}>
              <IconPlus size={14} />
              <span>添加</span>
            </button>
          </div>
        </details>
      </section>

      {/* Pocket48 Login Modal */}
      {showLogin && (
        <div className="modal-backdrop" onClick={closeLogin}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <span className="modal-icon-badge primary">
                  <IconSmartphone size={18} />
                </span>
                <h3>登录口袋48账号</h3>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeLogin}
                aria-label="关闭"
              >
                <IconX size={16} />
              </button>
            </div>
            <form onSubmit={submitLogin}>
              <div className="modal-body">
                <div aria-label="登录方式" style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
                  {[['sms', '短信登录'], ['password', '密码登录'], ['token', '凭据导入']].map(([mode, label]) => <button key={mode} type="button" aria-pressed={loginMode === mode} disabled={loginBusy || smsBusy} className={`btn btn-sm ${loginMode === mode ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setLoginMode(mode); setLoginError(''); setLogin(val => ({ ...val, code: '', password: '', token: '' })); setSmsChallenge(null); setChallengeAnswer(''); }}>{label}</button>)}
                </div>
                {loginError && <div className="admin-alert error">{loginError}</div>}

                <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "12px" }}>
                  {loginMode === 'sms' ? '验证码不会保存在服务器，仅用于换取短期访问凭据。' : loginMode === 'password' ? '使用口袋48账号密码，不是本站管理员密码。密码不会保存，登录后仅保存访问凭据。' : '高级选项：导入已有的口袋48访问凭据 Token。验证成功后会保存在服务器；请勿使用其他平台的 Token。'}
                </div>

                {loginMode !== 'token' && <div className="form-group">
                  <label htmlFor="p48-mobile">手机号 (中国大陆 11 位)</label>
                  <input
                    id="p48-mobile"
                    type="tel"
                    maxLength={11}
                    placeholder="输入 11 位手机号"
                    value={login.mobile}
                    onChange={(e) =>
                      setLogin((val) => ({ ...val, mobile: e.target.value }))
                    }
                  />
                </div>}

                {loginMode === 'password' && <div className="form-group"><label htmlFor="p48-password">口袋48账号密码</label><input id="p48-password" type="password" autoComplete="current-password" maxLength={128} value={login.password} onChange={e => setLogin(val => ({ ...val, password: e.target.value }))} placeholder="输入口袋48密码" /></div>}
                {loginMode === 'token' && <div className="form-group"><label htmlFor="p48-token">访问凭据 Token</label><input id="p48-token" type="password" autoComplete="off" maxLength={4096} value={login.token} onChange={e => setLogin(val => ({ ...val, token: e.target.value }))} placeholder="粘贴已有的口袋48 Token" /></div>}
                {loginMode === 'sms' && <div className="form-group">
                  <label htmlFor="p48-code">短信验证码</label>
                  <div style={{ display: "flex", gap: "10px" }}>
                    <input
                      id="p48-code"
                      type="text"
                      maxLength={8}
                      autoComplete="one-time-code"
                      placeholder="6 位验证码"
                      value={login.code}
                      onChange={(e) =>
                        setLogin((val) => ({ ...val, code: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={sendSms}
                      disabled={loginBusy || smsBusy || smsCooldown > 0}
                    >
                      {smsBusy
                        ? "发送中…"
                        : smsCooldown > 0
                        ? `${smsCooldown} 秒后重试`
                        : "获取验证码"}
                    </button>
                  </div>
                </div>}

                {loginMode === 'sms' && smsChallenge && (
                  <div
                    style={{
                      padding: "12px",
                      background: "var(--bg-panel)",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <span style={{ fontSize: "12px", color: "var(--text-soft)", fontWeight: 600 }}>
                      安全验证题目：{smsChallenge.question}
                    </span>
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                      {smsChallenge.options?.map((opt, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className={`btn btn-sm ${challengeAnswer === opt ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setChallengeAnswer(opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeLogin}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={loginBusy || smsBusy}
                >
                  {loginBusy ? "验证中…" : "确认登录"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

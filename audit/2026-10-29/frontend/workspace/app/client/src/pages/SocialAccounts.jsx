import React, { useEffect, useMemo, useRef, useState } from "react";
import PlatformIcon, { brandOf } from "../components/PlatformIcon";
import ConfirmModal from "../components/ConfirmModal";
import EmptyState from "../components/EmptyState";
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from "../components/Icons";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "../components/Toast";
import "./SocialAccounts.css";

// Platform names and group kinds render from the API snapshot.
const PLATFORM_ORDER = ["weibo", "xiaohongshu", "douyin", "bilibili", "group"];
const FALLBACK_GROUP_KINDS = [
  { key: "weibo_group", name: "微博群" },
  { key: "qq", name: "QQ群" },
  { key: "wechat", name: "微信群" },
  { key: "fanqie", name: "番茄/应援会" },
  { key: "other", name: "其他" },
];

function blankDraft(memberName = "") {
  return {
    memberName,
    platform: "weibo",
    groupKind: "weibo_group",
    accountId: "",
    accountName: "",
    memberCount: "",
    note: "",
  };
}

function draftFrom(account) {
  return {
    memberName: account.memberName,
    platform: account.platform,
    groupKind: account.groupKind || "weibo_group",
    accountId: account.accountId || "",
    accountName: account.accountName || "",
    memberCount: account.memberCount ?? "",
    note: account.note || "",
  };
}

function groupKindLabel(key) {
  const preset = FALLBACK_GROUP_KINDS.find((item) => item.key === key);
  if (preset) return preset.name;
  if (typeof key === "string" && key.startsWith("other:")) return key.slice(6) || "应援群";
  return key || "应援群";
}

// Keep account cards grouped by platform without imposing account subtypes.
function rowRank(account) {
  const platform = PLATFORM_ORDER.indexOf(account.platform);
  return String(platform < 0 ? 99 : platform).padStart(2, "0");
}

export default function SocialAccounts() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState({ accounts: [], links: {}, platforms: [], groupKinds: [] });
  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [view, setView] = useState("member"); // member | platform
  const [pending, setPending] = useState(null);
  const [removing, setRemoving] = useState(false);
  // Access codes: a guest link shows one member's accounts. The plaintext code
  // is only ever held in this component's state, never written back to the API.
  const [codes, setCodes] = useState([]);
  const [codeMember, setCodeMember] = useState("");
  const [codeHours, setCodeHours] = useState(72);
  const [freshCode, setFreshCode] = useState(null);
  const [codeBusy, setCodeBusy] = useState(false);

  async function loadCodes() {
    try { setCodes(payload(await adminApi.get("/social/access-codes"), {}).codes || []); }
    catch (error) { toast.error(errorMessage(error, "访问码读取失败")); }
  }
  async function createCode() {
    if (!codeMember) { toast.error("请选择要分享的成员"); return; }
    setCodeBusy(true);
    try {
      const created = payload(await adminApi.post("/social/access-codes", { memberName: codeMember, hours: Number(codeHours) }), {});
      setFreshCode(created);
      toast.success("访问码已生成，链接只显示这一次");
      await loadCodes();
    } catch (error) { toast.error(errorMessage(error, "生成访问码失败")); }
    finally { setCodeBusy(false); }
  }
  async function revokeCode(id) {
    setCodeBusy(true);
    try { await adminApi.delete(`/social/access-codes/${id}`); if (freshCode?.memberName === codes.find((row) => row.id === id)?.memberName) setFreshCode(null); toast.success("访问码已撤销"); await loadCodes(); }
    catch (error) { toast.error(errorMessage(error, "撤销失败")); }
    finally { setCodeBusy(false); }
  }
  // Visitors open a page, not JSON; the page calls the same public endpoint.
  const shareUrl = (code) => `${window.location.origin}/s/${code}`;

  const accounts = data.accounts || [];
  const platforms = useMemo(() => {
    const list = data.platforms?.length ? data.platforms : PLATFORM_ORDER.map((key) => ({ key, name: brandOf(key).label }));
    return [...list].sort((a, b) => PLATFORM_ORDER.indexOf(a.key) - PLATFORM_ORDER.indexOf(b.key));
  }, [data.platforms]);
  const groupKinds = data.groupKinds?.length ? data.groupKinds : FALLBACK_GROUP_KINDS;

  useEffect(() => {
    let cancelled = false;
    adminApi
      .get("/social")
      .then((response) => {
        if (!cancelled) setData((current) => ({ ...current, ...payload(response, {}) }));
      })
      .catch((error) => {
        if (!cancelled) {
          const message = errorMessage(error, "社交账号读取失败");
          setLoadError(message);
          toast.error(message);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadCodes(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const memberNames = useMemo(
    () => [...new Set(accounts.map((item) => item.memberName))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [accounts]
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return accounts.filter((item) => {
      if (platformFilter && item.platform !== platformFilter) return false;
      if (!keyword) return true;
      const haystack = `${item.memberName} ${item.accountName} ${item.accountId} ${item.note || ""} ${brandOf(item.platform).label}`.toLocaleLowerCase("zh-CN");
      return haystack.includes(keyword);
    });
  }, [accounts, platformFilter, query]);

  const memberGroups = useMemo(() => {
    const map = new Map();
    for (const account of filtered) {
      if (!map.has(account.memberName)) map.set(account.memberName, []);
      map.get(account.memberName).push(account);
    }
    return [...map]
      .map(([memberName, rows]) => ({
        memberName,
        rows: [...rows].sort((a, b) => rowRank(a).localeCompare(rowRank(b))),
        banned: Boolean(data.links?.[memberName]?.banned),
        note: data.links?.[memberName]?.note || "",
      }))
      .sort((a, b) => a.memberName.localeCompare(b.memberName, "zh-CN"));
  }, [filtered, data.links]);

  // Platform view: who has (or has not) been linked on each site. Missing
  // handles for the group as a whole stay visible instead of being buried in
  // the per-member cards.
  const byPlatform = useMemo(() => {
    const seenMembers = new Set(accounts.map((item) => item.memberName));
    return platforms.filter((platform) => !platformFilter || platform.key === platformFilter).map((platform) => {
      const rows = filtered
        .filter((item) => item.platform === platform.key)
        .sort((a, b) => a.memberName.localeCompare(b.memberName, "zh-CN") || rowRank(a).localeCompare(rowRank(b)));
      const linkedMembers = new Set(accounts.filter((item) => item.platform === platform.key).map((item) => item.memberName));
      return { platform, rows, missing: [...seenMembers].filter((name) => !linkedMembers.has(name)).length };
    });
  }, [accounts, filtered, platforms, platformFilter]);

  const counts = useMemo(() => {
    const result = { members: memberNames.length, total: accounts.length };
    for (const platform of platforms) result[platform.key] = accounts.filter((item) => item.platform === platform.key).length;
    return result;
  }, [accounts, memberNames, platforms]);

  async function save(draft) {
    const body = {
      memberName: draft.memberName.trim(),
      platform: draft.platform,
      size: "", // Retire legacy subtype when editing; its description is kept in note.
      groupKind: draft.platform === "group" ? draft.groupKind : "",
      accountId: draft.accountId,
      accountName: draft.accountName,
      memberCount: draft.platform === "group" && draft.memberCount !== "" ? Number(draft.memberCount) : null,
      note: draft.note,
    };
    if (!body.memberName) throw new Error("请选择成员");
    if (!String(body.accountId || "").trim()) throw new Error(draft.platform === "group" ? "请填写群名或群号" : "请填写账号 ID 或账号名");
    if (body.platform === "group" && !body.groupKind) throw new Error("请选择应援群类型");
    setSaving(true);
    try {
      const response =
        pending?.mode === "edit"
          ? await adminApi.put(`/social/accounts/${pending.id}`, body)
          : await adminApi.post("/social/accounts", body);
      const saved = payload(response, {});
      setData((current) => ({ ...current, accounts: saved.accounts || current.accounts }));
      toast.success(pending?.mode === "edit" ? "账号信息已更新" : "已添加账号");
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!pending?.id) return;
    setRemoving(true);
    try {
      const response = await adminApi.delete(`/social/accounts/${pending.id}`);
      const saved = payload(response, {});
      setData((current) => ({ ...current, accounts: saved.accounts || current.accounts }));
      toast.success("已删除该条记录");
      setPending(null);
    } catch (error) {
      toast.error(errorMessage(error, "删除失败"));
    } finally {
      setRemoving(false);
    }
  }

  async function toggleBan(memberName, banned, currentNote) {
    try {
      const response = await adminApi.put(`/social/members/${encodeURIComponent(memberName)}`, { banned, note: currentNote });
      const saved = payload(response, {});
      setData((current) => ({ ...current, links: saved.links || current.links }));
      toast.success(banned ? "已标记为同名不同人，重复导入会跳过该成员" : "已取消标记");
    } catch (error) {
      toast.error(errorMessage(error, "标记失败"));
    }
  }

  return (
    <div className="social-page">
      <header className="page-header admin-page-header">
        <div>
          <span className="eyebrow">MEMBERS</span>
          <h1>成员社交账号</h1>
          <p>记录成员的公开账号与应援群，大小号等说明写在备注中。请勿填写密码或验证码。</p>
        </div>
        <div className="sa-header-actions">
          <button type="button" className="btn btn-primary" onClick={() => setPending({ mode: "create", draft: blankDraft() })} disabled={loading || Boolean(loadError)}>
            <IconPlus size={15} />
            <span>新增账号</span>
          </button>
        </div>
      </header>

      <section className="sa-share" aria-label="成员资料分享">
        <h2>分享成员资料</h2>
        <p className="sa-share-hint">生成一条限时链接，对方无需登录即可查看该成员的平台账号、昵称与主页。备注与其它成员不会外泄。</p>
        <div className="sa-share-form">
          <select aria-label="选择分享成员" value={codeMember} onChange={(event) => setCodeMember(event.target.value)}>
            <option value="">选择成员…</option>
            {memberNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select aria-label="访问码有效期" value={codeHours} onChange={(event) => setCodeHours(Number(event.target.value))}>
            <option value={24}>24 小时</option>
            <option value={72}>3 天</option>
            <option value={168}>7 天</option>
            <option value={720}>30 天</option>
          </select>
          <button type="button" className="btn btn-primary" disabled={codeBusy || !codeMember} onClick={createCode}>生成链接</button>
        </div>
        {freshCode && (
          <div className="sa-share-fresh" role="status">
            <p>链接只显示这一次，请立即复制：</p>
            <code>{shareUrl(freshCode.code)}</code>
            <button type="button" className="btn btn-secondary" onClick={() => { navigator.clipboard?.writeText(shareUrl(freshCode.code)).then(() => toast.success("链接已复制"), () => toast.error("复制失败，请手动选择")); }}>复制</button>
          </div>
        )}
        {codes.length > 0 && (
          <ul className="sa-share-list" aria-label="已有访问码">
            {codes.map((row) => (
              <li key={row.id}>
                <span>{row.memberName}</span>
                <span>{row.expired ? "已过期" : `有效至 ${new Date(row.expiresAt).toLocaleString("zh-CN", { hour12: false })}`}{row.uses ? ` · 已访问 ${row.uses} 次` : " · 尚无访问"}{row.lastUsedAt ? ` · 最近 ${new Date(row.lastUsedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}</span>
                <button type="button" className="btn btn-secondary" disabled={codeBusy} onClick={() => revokeCode(row.id)}>撤销</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sa-stats" aria-label="账号概况">
        <StatCard label="已登记成员" value={counts.members} hint="至少有一条账号记录" />
        <StatCard label="账号总数" value={counts.total} hint="含各平台账号与群" />
        <StatCard label="应援群" value={counts.group || 0} tone="group" hint="微博群、QQ群、微信群等" />
      </section>

      <div className="sa-toolbar">
        <div className="sa-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索成员、账号、ID 或备注"
            aria-label="搜索账号"
          />
        </div>
        <div className="sa-filter" role="group" aria-label="按平台筛选">
          <button type="button" className={`sa-chip ${platformFilter === "" ? "active" : ""}`} onClick={() => setPlatformFilter("")}>
            全部
          </button>
          {platforms.map((platform) => (
            <button
              key={platform.key}
              type="button"
              className={`sa-chip ${platformFilter === platform.key ? "active" : ""}`}
              onClick={() => setPlatformFilter(platform.key)}
            >
              {platform.name}
              <em>{counts[platform.key] || 0}</em>
            </button>
          ))}
        </div>
        <div className="sa-view-toggle" role="group" aria-label="切换视图">
          <button type="button" className={view === "member" ? "active" : ""} onClick={() => setView("member")}>
            按成员
          </button>
          <button type="button" className={view === "platform" ? "active" : ""} onClick={() => setView("platform")}>
            按平台
          </button>
        </div>
      </div>

      {loading ? (
        <div className="sa-loading">正在读取账号数据…</div>
      ) : loadError ? (
        <div className="sa-loading" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          title="还没有登记任何社交账号"
          detail="先新增一条记录：填写成员、平台和账号 ID，需要区分大小号时写在备注中即可。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setPending({ mode: "create", draft: blankDraft() })}>
              <IconPlus size={15} />
              <span>新增账号</span>
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={IconSearch} title="没有匹配的账号" detail="换个关键词，或切换到全部平台。" />
      ) : view === "member" ? (
        <MemberView
          groups={memberGroups}
          onAdd={(memberName) => setPending({ mode: "create", draft: blankDraft(memberName) })}
          onEdit={(account) => setPending({ mode: "edit", id: account.id, draft: draftFrom(account) })}
          onRemove={(account) => setPending({ mode: "remove", id: account.id, memberName: account.memberName, platform: account.platform })}
          onToggleBan={(group) => toggleBan(group.memberName, !group.banned, group.note)}
        />
      ) : (
        <PlatformView
          groups={byPlatform}
          onAdd={(platform) => setPending({ mode: "create", draft: { ...blankDraft(), platform: platform.key } })}
          onEdit={(account) => setPending({ mode: "edit", id: account.id, draft: draftFrom(account) })}
          onRemove={(account) => setPending({ mode: "remove", id: account.id, memberName: account.memberName, platform: account.platform })}
        />
      )}

      {pending && pending.mode !== "remove" && (
        <AccountEditor
          busy={saving}
          draft={pending.draft}
          mode={pending.mode}
          groupKinds={groupKinds}
          platforms={platforms}
          members={memberNames}
          onCancel={() => setPending(null)}
          onSubmit={save}
        />
      )}

      <ConfirmModal
        isOpen={pending?.mode === "remove"}
        title="删除这条账号记录"
        description={`将删除 ${pending?.memberName || ""} 的「${brandOf(pending?.platform).label}」记录，删除后无法恢复。`}
        confirmText="删除"
        isLoading={removing}
        onConfirm={remove}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function StatCard({ label, value, hint, tone }) {
  return (
    <div className={`sa-stat ${tone ? `is-${tone}` : ""}`}>
      <span className="sa-stat-label">{label}</span>
      <strong className="sa-stat-value">{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

// Native disclosure supports mouse, keyboard and touch without a menu dependency.
function MoreMenu({ label, children }) {
  const ref = useRef(null);
  useEffect(() => {
    function dismiss(event) {
      if (ref.current?.open && !ref.current.contains(event.target)) ref.current.open = false;
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details className="sa-more" ref={ref} onKeyDown={(event) => {
      if (event.key === "Escape" && ref.current?.open) {
        event.preventDefault();
        event.stopPropagation();
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    }}>
      <summary aria-label={label} title={label}><span aria-hidden="true">···</span></summary>
      <div className="sa-more-options" onClick={(event) => {
        if (event.target.closest("button")) {
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}>{children}</div>
    </details>
  );
}

function AccountCard({ account, onEdit, onRemove, showMember }) {
  const brand = brandOf(account.platform);
  const name = account.accountName || account.accountId;
  const secondary = [
    account.platform === "group" ? groupKindLabel(account.groupKind) : brand.label,
    account.accountName && account.accountName !== account.accountId ? account.accountId : "",
    account.platform === "group" && account.memberCount ? `${account.memberCount} 人` : "",
  ].filter(Boolean).join(" · ");
  return (
    <article className="sa-card">
      <PlatformIcon platform={account.platform} size={28} />
      <div className="sa-card-title">
        {showMember && <small className="sa-card-member">{account.memberName}</small>}
        <div className="sa-card-name">
          {account.profileUrl ? (
            <a className="sa-account-link" href={account.profileUrl} target="_blank" rel="noopener noreferrer" title={`${name} · 打开主页`}>
              <strong>{name}</strong><IconExternalLink size={12} />
            </a>
          ) : <strong title={name}>{name}</strong>}
        </div>
        <small className="sa-account-secondary" title={secondary}>{secondary}</small>
        {account.note && <p className="sa-card-note" title={account.note}>{account.note}</p>}
      </div>
      <div className="sa-card-actions">
        <MoreMenu label={`更多账号操作：${name}`}>
          <button type="button" onClick={() => onEdit(account)}>编辑</button>
          <button type="button" className="danger" onClick={() => onRemove(account)} aria-label={`删除 ${name}`}>
            <IconTrash size={14} />删除
          </button>
        </MoreMenu>
      </div>
    </article>
  );
}

function MemberView({ groups, onAdd, onEdit, onRemove, onToggleBan }) {
  return (
    <div className="sa-members">
      {groups.map((group) => (
        <section className="sa-member" key={group.memberName}>
          <div className="sa-member-head">
            <div>
              <h2>{group.memberName}</h2>
              <small>
                {group.rows.length} 条记录
                {group.banned && <span className="sa-flag"> · 同名不同人（已停止自动关联）</span>}
              </small>
            </div>
            <div className="sa-member-actions">
              <button type="button" className="text-button" onClick={() => onAdd(group.memberName)}>
                <IconPlus size={14} />
                <span>添加</span>
              </button>
              <MoreMenu label={`更多成员操作：${group.memberName}`}>
                <button type="button" onClick={() => onToggleBan(group)} title="平台上的同名账号可能不是本人时，标记后重复导入会跳过该成员">
                  <IconAlertTriangle size={14} />
                  <span>{group.banned ? "取消标记" : "标记同名"}</span>
                </button>
              </MoreMenu>
            </div>
          </div>
          <div className="sa-cards">
            {group.rows.map((account) => (
              <AccountCard key={account.id} account={account} onEdit={onEdit} onRemove={onRemove} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PlatformView({ groups, onAdd, onEdit, onRemove }) {
  return (
    <div className="sa-platforms">
      {groups.map(({ platform, rows, missing }) => (
        <section className="sa-platform" key={platform.key}>
          <div className="sa-platform-head">
            <div className="sa-card-name">
              <PlatformIcon platform={platform.key} size={30} />
              <h2>{platform.name}</h2>
              <span className="sa-count">{rows.length}</span>
            </div>
            <button type="button" className="text-button" onClick={() => onAdd(platform)}>
              <IconPlus size={14} />
              <span>添加</span>
            </button>
          </div>
          {missing > 0 && <p className="sa-platform-hint">{missing} 位已登记成员尚未记录该平台账号</p>}
          {rows.length === 0 ? (
            <p className="sa-platform-empty">暂无记录</p>
          ) : (
            <div className="sa-cards">
              {rows.map((account) => (
                <AccountCard key={account.id} account={account} showMember onEdit={onEdit} onRemove={onRemove} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function AccountEditor({ draft: initial, mode, busy, groupKinds, platforms, members, onCancel, onSubmit }) {
  const [draft, setDraft] = useState(initial);
  const formRef = useRef(null);
  const submitting = useRef(false);
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState("");
  const [roster, setRoster] = useState([]);
  const [rosterState, setRosterState] = useState("loading");
  const [rosterAttempt, setRosterAttempt] = useState(0);
  const [lookup, setLookup] = useState({ state: "idle", message: "" });
  const [composing, setComposing] = useState(false);
  const lookupRef = useRef({ version: 0, key: "", pending: false, timer: null, alive: true });
  const draftRef = useRef(initial);
  // Even an intentionally cleared manual nickname is protected from late replies.
  const nameSource = useRef(initial.accountName ? "manual" : "empty");

  useEffect(() => {
    lookupRef.current.alive = true;
    return () => {
      lookupRef.current.alive = false;
      lookupRef.current.version++;
      clearTimeout(lookupRef.current.timer);
    };
  }, []);

  function invalidateLookup() {
    lookupRef.current.version++;
    lookupRef.current.key = "";
    lookupRef.current.pending = false;
    clearTimeout(lookupRef.current.timer);
    setLookup({ state: "idle", message: "" });
  }

  async function lookupName(force = false) {
    clearTimeout(lookupRef.current.timer);
    const current = draftRef.current;
    if (busy || submitting.current || composing || current.platform === "group" || !current.accountId.trim()) return;
    const key = `${current.platform}\n${current.accountId}`;
    if (lookupRef.current.key === key && (!force || lookupRef.current.pending)) return;
    lookupRef.current.key = key;
    lookupRef.current.pending = true;
    const version = ++lookupRef.current.version;
    setLookup({ state: "loading", message: "识别中…仍可手填昵称或直接保存。" });
    const isCurrent = () => lookupRef.current.alive && lookupRef.current.version === version;
    try {
      const response = await adminApi.post("/social/lookup", { platform: current.platform, accountId: current.accountId });
      if (!isCurrent()) return;
      const result = payload(response, {});
      const name = typeof result?.accountName === "string" ? result.accountName.trim() : "";
      if (result?.recognized === true && name) {
        if (nameSource.current !== "manual") {
          nameSource.current = "auto";
          draftRef.current = { ...draftRef.current, accountName: name };
          setDraft(draftRef.current);
        }
        setLookup({ state: "success", message: nameSource.current === "manual" ? `已读取昵称：${name}；保留你填写的昵称。` : `已读取昵称：${name}` });
      } else {
        setLookup({ state: "limited", message: `平台限制，暂未读取昵称，请手填（也可留空保存）。${result?.message || ""}` });
      }
    } catch (error) {
      if (isCurrent()) setLookup({ state: "error", message: `昵称识别失败：${errorMessage(error, "平台暂不可用")}；可手填或留空保存。` });
    } finally {
      if (isCurrent()) lookupRef.current.pending = false;
    }
  }

  useEffect(() => {
    if (draft.platform === "group" || !draft.accountId.trim() || composing || busy) return;
    lookupRef.current.timer = setTimeout(() => lookupName(), 650);
    return () => clearTimeout(lookupRef.current.timer);
    // Other draft fields must not restart a pending lookup or move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.platform, draft.accountId, composing, busy]);

  const memberOptions = useMemo(() => {
    const names = new Map(members.map((name) => [name, { name, detail: "已登记成员" }]));
    for (const member of roster) {
      if (typeof member.memberName === "string" && member.memberName.trim()) {
        names.set(member.memberName, { name: member.memberName, detail: member.groupName || "口袋48成员目录" });
      }
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [members, roster]);

  useEffect(() => {
    let alive = true;
    setRosterState("loading");
    adminApi.get("/pocket48/members").then((response) => {
      if (!alive) return;
      const result = payload(response, {});
      if (!Array.isArray(result?.list)) throw new Error("成员目录格式不正确");
      setRoster(result.list);
      setRosterState(result.list.length ? "ready" : "empty");
    }).catch(() => { if (alive) setRosterState("error"); });
    return () => { alive = false; };
  }, [rosterAttempt]);

  useEffect(() => {
    const previous = document.activeElement;
    formRef.current?.querySelector(initial.memberName ? "#sa-account-id" : "#sa-member")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const [customKindOn, setCustomKindOn] = useState(
    typeof initial.groupKind === "string" && initial.groupKind.startsWith("other:")
  );
  const isGroup = draft.platform === "group";
  const customKind = typeof draft.groupKind === "string" && draft.groupKind.startsWith("other:")
    ? draft.groupKind.slice(6)
    : "";

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  function set(key, value) {
    let next = { ...draftRef.current, [key]: value };
    if ((key === "accountId" || key === "platform") && value !== draftRef.current[key]) {
      invalidateLookup();
      if (nameSource.current === "auto") {
        next.accountName = "";
        nameSource.current = "empty";
      }
    }
    if (key === "accountName") nameSource.current = "manual";
    draftRef.current = next;
    setDraft(next);
    setErrors((current) => ({ ...current, [key]: "" }));
    setSaveError("");
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || submitting.current) return;
    const next = {};
    if (!draft.memberName.trim()) next.memberName = "请选择或填写成员名";
    if (!String(draft.accountId || "").trim()) next.accountId = isGroup ? "请填写群名或群号" : "请填写账号 ID、账号名或主页链接";
    if (isGroup && (!draft.groupKind || (customKindOn && !customKind.trim()))) next.groupKind = "请填写应援群类型";
    if (isGroup && draft.memberCount !== "" && (!Number.isInteger(Number(draft.memberCount)) || Number(draft.memberCount) < 0 || Number(draft.memberCount) > 5000000)) next.memberCount = "群人数须为 0 至 5000000 的整数";
    setErrors(next);
    setSaveError("");
    if (Object.keys(next).length) {
      const ids = { memberName: "sa-member", accountId: "sa-account-id", groupKind: customKindOn ? "sa-custom-kind" : "sa-group-kind", memberCount: "sa-count" };
      formRef.current?.querySelector(`#${ids[Object.keys(next)[0]]}`)?.focus();
      return;
    }
    submitting.current = true;
    invalidateLookup();
    try { await onSubmit(draft); }
    catch (error) {
      const message = errorMessage(error, "保存失败，请检查填写内容后重试");
      // Field metadata is optional. Unknown/network failures stay at the summary.
      const field = error?.response?.data?.field;
      const ids = { memberName: "sa-member", accountId: "sa-account-id", groupKind: customKindOn ? "sa-custom-kind" : "sa-group-kind", memberCount: "sa-count", accountName: "sa-account-name", note: "sa-note" };
      setSaveError(message);
      if (ids[field]) setErrors({ [field]: message });
      requestAnimationFrame(() => formRef.current?.querySelector(ids[field] ? `#${ids[field]}` : "#sa-save-error")?.focus());
    } finally { submitting.current = false; }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
    if (event.key !== "Tab") return;
    const nodes = [...formRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <form
        ref={formRef}
        className="modal-card sa-editor"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label={mode === "edit" ? "编辑账号" : "新增账号"}
        onSubmit={submit}
        noValidate
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon-badge primary">
              <PlatformIcon platform={draft.platform} size={22} />
            </span>
            <h3>{mode === "edit" ? "编辑账号" : "新增账号"}</h3>
          </div>
          <button type="button" className="modal-close-btn" onClick={onCancel} disabled={busy} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>

        <div className="modal-body sa-editor-body">
          <p className="sa-editor-intro">填写成员、平台和账号即可保存，其余选填。大小号等说明统一写在备注中。</p>
          {saveError && <div id="sa-save-error" className="sa-editor-error" role="alert" tabIndex={-1}>{saveError}</div>}
          <div className="form-group">
            <label htmlFor="sa-member">成员</label>
            <input
              id="sa-member"
              list="sa-member-options"
              value={draft.memberName}
              placeholder="搜索成员名，也可直接手填"
              autoComplete="off"
              aria-describedby="sa-member-hint sa-member-error"
              aria-invalid={Boolean(errors.memberName)}
              disabled={busy}
              onChange={(event) => set("memberName", event.target.value)}
            />
            <datalist id="sa-member-options">
              {memberOptions.map(({ name, detail }) => (
                <option key={name} value={name} label={detail} />
              ))}
            </datalist>
            <small id="sa-member-hint" className="sa-hint" role="status">
              {rosterState === "loading" ? "正在加载口袋48成员目录，可先手填。" : rosterState === "error" ? "成员目录暂不可用，仍可手填或选择已登记成员。" : rosterState === "empty" ? "成员目录暂无内容，可直接手填。" : "搜索并选择口袋48目录成员，也支持填写未收录成员。"}
              {rosterState === "error" && <button type="button" className="text-button" disabled={busy} onClick={() => setRosterAttempt((n) => n + 1)}>重试</button>}
            </small>
            <small id="sa-member-error" className="sa-field-error" role={errors.memberName ? "alert" : undefined}>{errors.memberName}</small>
          </div>

          <div className="form-group">
            <label>平台</label>
            <div className="sa-platform-picker" role="radiogroup" aria-label="平台">
              {platforms.map((platform) => (
                <button
                  key={platform.key}
                  type="button"
                  role="radio"
                  aria-checked={draft.platform === platform.key}
                  tabIndex={draft.platform === platform.key ? 0 : -1}
                  onKeyDown={(event) => {
                    const keys = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"];
                    if (!keys.includes(event.key)) return;
                    event.preventDefault();
                    const index = platforms.findIndex((item) => item.key === draft.platform);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? platforms.length - 1
                      : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + platforms.length) % platforms.length;
                    set("platform", platforms[next].key);
                    event.currentTarget.parentElement.children[next]?.focus();
                  }}
                  className={`sa-platform-option ${draft.platform === platform.key ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => set("platform", platform.key)}
                >
                  <PlatformIcon platform={platform.key} size={22} />
                  <span>{platform.name}</span>
                  {draft.platform === platform.key && <IconCheck size={13} />}
                </button>
              ))}
            </div>
          </div>

          {isGroup && (
            <>
              <div className="form-group">
                <label htmlFor="sa-group-kind">应援群类型</label>
                <select
                  id="sa-group-kind"
                  aria-invalid={Boolean(errors.groupKind)}
                  aria-describedby="sa-kind-error"
                  value={customKindOn ? "custom" : draft.groupKind}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustomKindOn(value === "custom");
                    set("groupKind", value === "custom" ? "other:" : value);
                  }}
                >
                  {groupKinds.map((kind) => (
                    <option key={kind.key} value={kind.key}>
                      {kind.name}
                    </option>
                  ))}
                  <option value="custom">其他（自定义）</option>
                </select>
                {customKindOn && (
                  <input
                    id="sa-custom-kind"
                    aria-label="自定义应援群类型"
                    aria-invalid={Boolean(errors.groupKind)}
                    aria-describedby="sa-kind-error"
                    style={{ marginTop: 8 }}
                    placeholder="填写群类型，例如「微博应援群」"
                    disabled={busy}
                    value={customKind}
                    onChange={(event) => set("groupKind", `other:${event.target.value}`)}
                  />
                )}
                <small id="sa-kind-error" className="sa-field-error" role={errors.groupKind ? "alert" : undefined}>{errors.groupKind}</small>
              </div>
              <div className="form-group">
                <label htmlFor="sa-count">群人数（可选）</label>
                <input
                  id="sa-count"
                  aria-invalid={Boolean(errors.memberCount)}
                  aria-describedby="sa-count-error"
                  type="number"
                  min="0"
                  max="5000000"
                  value={draft.memberCount}
                  disabled={busy}
                  onChange={(event) => set("memberCount", event.target.value)}
                  placeholder="例如 480"
                />
                <small id="sa-count-error" className="sa-field-error" role={errors.memberCount ? "alert" : undefined}>{errors.memberCount}</small>
              </div>
            </>
          )}

          <div className="form-group">
            <label htmlFor="sa-account-id">{isGroup ? "群名 / 群号" : "账号 ID / 主页链接"}</label>
            <input
              id="sa-account-id"
              aria-invalid={Boolean(errors.accountId)}
              aria-describedby="sa-account-hint sa-account-error"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.accountId}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => set("accountId", event.target.value)}
              onBlur={() => lookupName()}
              onCompositionStart={() => { setComposing(true); invalidateLookup(); }}
              onCompositionEnd={() => setComposing(false)}
              placeholder={isGroup ? "例如：张三应援一群 / 群号 12345" : placeholderFor(draft.platform)}
            />
            <small id="sa-account-hint" className="sa-hint">{isGroup ? "填写能识别到群的信息即可，可直接粘贴群号。" : hintFor(draft.platform)}</small>
            <small id="sa-account-error" className="sa-field-error" role={errors.accountId ? "alert" : undefined}>{errors.accountId}</small>
          </div>

          {!isGroup && (
            <div className="form-group">
              <label htmlFor="sa-account-name">账号昵称（可选）</label>
              <input
                id="sa-account-name"
                aria-invalid={Boolean(errors.accountName)}
                aria-describedby="sa-lookup-status sa-name-error"
                value={draft.accountName}
                disabled={busy}
                onChange={(event) => set("accountName", event.target.value)}
                placeholder="平台上显示的名字"
              />
              <div className="sa-lookup-row">
                <small id="sa-lookup-status" className={`sa-lookup-status sa-lookup-${lookup.state === "limited" ? "unsupported" : lookup.state}`} role="status" aria-live="polite" aria-atomic="true">
                  {lookup.message || "输入账号后自动读取昵称；可手填，也可留空保存。"}
                </small>
                <button type="button" className="text-button sa-lookup-button sa-lookup-retry" disabled={busy || composing || lookup.state === "loading" || !draft.accountId.trim()} onClick={() => lookupName(true)}>
                  {lookup.state === "loading" ? "识别中…" : lookup.state === "idle" ? "读取昵称" : "重试识别"}
                </button>
              </div>
              <small id="sa-name-error" className="sa-field-error" role={errors.accountName ? "alert" : undefined}>{errors.accountName}</small>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="sa-note">{isGroup ? "入群方式 / 备注" : "备注（可选）"}</label>
            <textarea
              id="sa-note"
              aria-invalid={Boolean(errors.note)}
              aria-describedby="sa-note-error"
              rows={3}
              maxLength={Math.max(300, initial.note?.length || 0)}
              value={draft.note}
              disabled={busy}
              onChange={(event) => set("note", event.target.value)}
              placeholder={isGroup ? "例如：申请时备注「48tools」，或直接扫码" : "例如：大号、小号、日常号或其他说明"}
            />
            <small id="sa-note-error" className="sa-field-error" role={errors.note ? "alert" : undefined}>{errors.note}</small>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <span className="sa-save-status" role="status">{busy ? "正在保存，请稍候" : "Enter 保存 · 备注可换行"}</span>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "正在保存…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

function placeholderFor(platform) {
  if (platform === "weibo") return "粘贴微博主页链接，或输入 UID / 账号名";
  if (platform === "xiaohongshu") return "粘贴小红书主页链接，或输入用户 ID";
  if (platform === "douyin") return "粘贴抖音主页链接，或输入 sec_uid / 抖音号";
  if (platform === "bilibili") return "粘贴 B站空间链接，或输入数字 UID";
  return "账号 ID 或主页链接";
}

function hintFor(platform) {
  const names = { weibo: "微博", xiaohongshu: "小红书", douyin: "抖音", bilibili: "B站" };
  return `可直接粘贴${names[platform] || "平台"}主页链接，无需手动截取 ID；原输入交由服务端识别。不支持的链接会提示修改。`;
}

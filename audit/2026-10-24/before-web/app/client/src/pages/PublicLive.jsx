import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import usePolling from "../hooks/usePolling";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconChevronRight,
  IconRadio,
  IconRefresh,
  IconSearch,
  IconTv,
} from "../components/Icons";
import LoadingState from "../components/LoadingState";
import PublicMediaTabs from "../components/PublicMediaTabs";
import SafeImage from "../components/SafeImage";
import VideoPlayer from "../components/VideoPlayer";
import { errorMessage, listPayload, payload, publicApi } from "../lib/api";

function normalizeLive(item = {}, text = {}) {
  const source = item.content || item.live || item;
  const user = source.userInfo || source.member || source.user || {};
  return {
    ...source,
    liveId: String(source.liveId ?? source.id ?? source.live_id ?? item.liveId ?? ""),
    title: source.title || source.liveTitle || source.roomName || text.liveBadge,
    memberName: user.nickname || user.name || source.memberName || source.nickname || text.members,
    avatar: user.avatar || user.avatarUrl || source.avatar || source.cover || "",
    cover: source.cover || source.coverUrl || source.thumb || source.image || "",
    category: source.liveTypeName || source.category || source.typeName || source.liveType || "直播",
    startedAt: source.startTime || source.startedAt || source.ctime || null,
  };
}

function formatStartedAt(value, text = {}) {
  if (!value) return text.liveBadge;
  const raw = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return text.liveBadge;
  return `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 开播`;
}

function LiveCard({ live, onSelect, text }) {
  return (
    <button
      className="public-live-card"
      onClick={() => onSelect(live)}
      aria-label={`观看 ${live.memberName} 的直播`}
    >
      <div className="live-cover">
        <SafeImage
          src={live.cover}
          fallback={
            <div className="cover-placeholder">
              <span>{live.memberName.slice(0, 1)}</span>
            </div>
          }
        />
        <span className="live-pill">
          <span className="live-pill-dot" /> LIVE
        </span>
        <span className="live-category">{live.category}</span>
      </div>
      <div className="live-card-body">
        <div className="member-avatar">
          <SafeImage
            src={live.avatar}
            fallback={<span>{live.memberName.slice(0, 1)}</span>}
          />
        </div>
        <div className="live-copy">
          <strong>{live.title}</strong>
          <span>
            {live.memberName} · {formatStartedAt(live.startedAt, text)}
          </span>
        </div>
        <span className="card-action-icon" aria-hidden="true">
          <IconChevronRight size={18} />
        </span>
      </div>
    </button>
  );
}


const TEXT = {
  zh: {
    liveBadge: "正在直播",
    members: "口袋48成员",
    liveWord: "直播",
    listError: "直播列表加载失败",
    noPlayUrl: "播放接口没有返回播放地址",
    badProtocol: "播放接口返回了不支持的协议",
    cannotPlay: "这条直播暂时无法播放",
    cannotPlayTitle: "直播暂时无法播放",
    online: "直播服务在线",
    checking: "正在检查服务",
    joining: "正在连接直播…",
    joiningSlow: "连接时间比平时更长…",
    joiningHint: "正在向口袋48获取播放地址。如果没有反应，请重试。",
    playerPrep: "正在准备播放器…",
    playerPrepSlow: "播放器准备时间比平时更长…",
    search: "搜索成员或标题…",
    refresh: "刷新列表",
    loading: "正在查找直播…",
    loadingSlow: "查找直播比平时更慢…",
    slowNote: "口袋48直播接口响应较慢。本页每 30 秒自动重试一次。",
    listUnavailable: "直播列表暂时不可用",
    empty: "没有匹配的直播",
    none: "当前没有正在进行的直播",
    emptyHint: "换一个关键词，或清空搜索。",
    noneHint: "成员开播后会自动出现在这里；本页每 30 秒刷新一次。",
    onAirHeading: "当前正在直播",
    autoSync: "页面自动同步开播状态",
  },
  en: {
    liveBadge: "Live now",
    members: "Pocket48 members",
    liveWord: "Live",
    listError: "Could not load the live list",
    noPlayUrl: "The play API returned no playUrl",
    badProtocol: "The play API returned an unsupported protocol",
    cannotPlay: "This live cannot be played right now",
    cannotPlayTitle: "Live unavailable",
    online: "Live service online",
    checking: "Checking service",
    joining: "Connecting to the live…",
    joiningSlow: "Connecting is taking longer than usual…",
    joiningHint: "Fetching the play address from Pocket48. If nothing happens, try again.",
    playerPrep: "Preparing the player…",
    playerPrepSlow: "Preparing the player is taking longer than usual…",
    search: "Search members or titles…",
    refresh: "Refresh the list",
    loading: "Finding lives…",
    loadingSlow: "Finding lives is taking longer than usual…",
    slowNote: "The Pocket48 live API is slow. This page retries every 30 seconds on its own.",
    listUnavailable: "The live list is unavailable right now",
    empty: "No live matches your search",
    none: "Nothing is on air right now",
    emptyHint: "Try another keyword or clear the search.",
    noneHint: "Lives appear here automatically when a member goes on air; the page refreshes every 30 seconds.",
    onAirHeading: "Live on air",
    autoSync: "The page updates live status automatically",
  }
};

export function languageOf(languages) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return typeof first === "string" && /^en\b/i.test(first) ? "en" : "zh";
}

export default function PublicLivePage() {
  const t = TEXT[languageOf(typeof navigator === "undefined" ? "zh" : navigator.languages || navigator.language)];
  const { liveId } = useParams();
  const navigate = useNavigate();
  const [lives, setLives] = useState([]);
  const [selected, setSelected] = useState(null);
  const [stream, setStream] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [playerError, setPlayerError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const playerRequestRef = useRef(0);

  const loadLives = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [liveResponse, healthResponse] = await Promise.all([
        publicApi.get("/live"),
        publicApi.get("/health").catch(() => null),
      ]);
      setLives(
        listPayload(liveResponse, ["liveList", "lives", "items", "content"])
          .map(normalizeLive)
          .filter((item) => item.liveId)
      );
      setHealth(healthResponse ? payload(healthResponse, {}) : null);
      setListError("");
    } catch (requestError) {
      // Keep the last known list rather than clearing it, and record why it may
      // be stale. Previously the list was emptied and the reason discarded, so a
      // backend outage rendered as the ordinary "nothing is streaming right now"
      // empty state and visitors concluded nobody was live.
      setListError(errorMessage(requestError, t.listError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // The first load must be non-quiet: `loadLives(false)` is the only path that
  // clears the initial `loading` flag, and usePolling always polls quietly. With
  // only the polling loop wired up the list spinner never went away — the page
  // looked stuck until the visitor pressed 刷新, which was the one thing that
  // happened to call loadLives(false).
  useEffect(() => {
    void loadLives();
  }, [loadLives]);

  usePolling(() => loadLives(true), 30000);

  const loadPlay = useCallback(async (id, serverFallback = false) => {
    const requestId = ++playerRequestRef.current;
    setPlayerLoading(true);
    setPlayerError("");
    setStream(null);
    try {
      const response = await publicApi.get(
        `/live/${encodeURIComponent(id)}/play`,
        serverFallback ? { params: { fallback: "server" } } : undefined
      );
      if (requestId !== playerRequestRef.current) return;
      const play = payload(response, {});
      const protocol = String(play.protocol || "").toLowerCase();
      if (!play.playUrl) throw new Error(t.noPlayUrl);
      if (protocol !== "hls" && protocol !== "flv")
        throw new Error(t.badProtocol);
      setStream({ ...play, type: protocol, proxyUrl: play.playUrl });
    } catch (requestError) {
      if (requestId === playerRequestRef.current) {
        setPlayerError(errorMessage(requestError, t.cannotPlay));
      }
    } finally {
      if (requestId === playerRequestRef.current) setPlayerLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!liveId) {
      playerRequestRef.current += 1;
      setSelected(null);
      setStream(null);
      setPlayerError("");
      setPlayerLoading(false);
      return () => {
        active = false;
      };
    }
    setSelected((current) =>
      current?.liveId === String(liveId) ? current : null
    );
    publicApi
      .get(`/live/${encodeURIComponent(liveId)}`)
      .then((response) => {
        if (active) setSelected(normalizeLive(payload(response, {}), t));
      })
      .catch(() => undefined);
    loadPlay(liveId);
    return () => {
      active = false;
      playerRequestRef.current += 1;
    };
  }, [liveId, loadPlay]);

  const serviceOnline = useMemo(
    () => Boolean(health) && health?.ok !== false && health?.status !== "offline",
    [health]
  );

  const filteredLives = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return lives;
    return lives.filter(
      (item) =>
        item.memberName.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    );
  }, [lives, searchQuery]);

  function selectLive(live) {
    setSelected(live);
    setStream(null);
    setPlayerError("");
    navigate(`/live/${encodeURIComponent(live.liveId)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="public-site">
      <header className="public-header">
        <div className="public-header-inner">
          <div className="public-brand">
            <div className="public-brand-logo">
              <IconTv size={18} />
            </div>
            <span>48tools</span>
            <span className="public-brand-version">{__APP_VERSION__}</span>
          </div>
          <div className={`service-state ${serviceOnline ? "online" : ""}`}>
            <span className="service-state-dot" />
            <span>{serviceOnline ? t.online : t.checking}</span>
          </div>
        </div>
      </header>

      <main className="public-main">
        <PublicMediaTabs active="live" liveCount={lives.length} />

        {liveId && (
          <section className="featured-live">
            <button className="back-link" onClick={() => navigate("/")}>
              <IconArrowLeft size={16} /> 返回直播列表
            </button>
            {playerLoading ? (
              <LoadingState
                text={t.joining}
                slowText={t.joiningSlow}
                slowAfterMs={8000}
                slowHint={t.joiningHint}
                onRetry={() => loadPlay(liveId)}
              />
            ) : playerError ? (
              <div className="player-request-error" role="alert">
                <IconAlertCircle size={32} color="#ff4757" />
                <strong>{t.cannotPlayTitle}</strong>
                <span>{playerError}</span>
                <button
                  className="btn btn-secondary"
                  onClick={() => loadPlay(liveId)}
                >
                  <IconRefresh size={14} /> 重新获取播放地址
                </button>
              </div>
            ) : stream?.proxyUrl ? (
              <>
                <VideoPlayer
                  mode="live"
                  stream={stream}
                  poster={selected?.cover}
                  title={selected?.title}
                  onRetry={() => loadPlay(liveId)}
                  onFallback={
                    stream.fallbackAvailable
                      ? () => loadPlay(liveId, true)
                      : undefined
                  }
                />
                {selected && (
                  <div className="featured-meta">
                    <div className="featured-heading">
                      <span className="live-pill">
                        <span className="live-pill-dot" /> LIVE
                      </span>
                      <h1>{selected.title}</h1>
                    </div>
                    <p>
                      <strong>{selected.memberName}</strong>
                      <span>·</span>
                      <span>{selected.category}</span>
                      <span>·</span>
                      <span>{formatStartedAt(selected.startedAt, t)}</span>
                    </p>
                  </div>
                )}
              </>
            ) : (
              <LoadingState text={t.playerPrep} slowText={t.playerPrepSlow} slowAfterMs={8000} />
            )}
          </section>
        )}

        <section className="public-list-section">
          <div className="public-filter-row">
            <div>
              <span className="eyebrow">NOW STREAMING</span>
              <h2>{t.onAirHeading}</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <div className="search-input-shell">
                <IconSearch size={15} />
                <input
                  type="text"
                  placeholder={t.search}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => loadLives()}
                title={t.refresh}
              >
                <IconRefresh size={14} /> 刷新
              </button>
            </div>
          </div>

          {listError && filteredLives.length > 0 && (
            <div className="public-alert" role="status">
              <IconAlertCircle size={15} />
              <span>列表可能不是最新的：{listError}。页面会每 30 秒自动重试。</span>
            </div>
          )}

          {loading ? (
            <LoadingState
              text={t.loading}
              slowText={t.loadingSlow}
              slowAfterMs={5000}
              slowHint={t.slowNote}
              onRetry={() => loadLives()}
            />
          ) : listError && filteredLives.length === 0 ? (
            <EmptyState
              icon={IconAlertCircle}
              title={t.listUnavailable}
              detail={`${listError}。这可能只是暂时的，页面会每 30 秒自动重试。`}
              action={
                <button
                  className="btn btn-secondary"
                  onClick={() => loadLives()}
                >
                  <IconRefresh size={14} /> 立即重试
                </button>
              }
            />
          ) : filteredLives.length > 0 ? (
            <div className="public-live-grid">
              {filteredLives.map((live) => (
                <LiveCard key={live.liveId} live={live} onSelect={selectLive} text={t} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={IconRadio}
              title={searchQuery ? t.empty : t.none}
              detail={
                searchQuery
                  ? t.emptyHint
                  : t.noneHint
              }
              action={
                searchQuery ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setSearchQuery("")}
                  >
                    清除搜索
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary"
                    onClick={() => loadLives()}
                  >
                    <IconRefresh size={14} /> 立即刷新
                  </button>
                )
              }
            />
          )}
        </section>
      </main>

      <footer className="public-footer">
        <span />
        <span>{t.autoSync}</span>
      </footer>
    </div>
  );
}

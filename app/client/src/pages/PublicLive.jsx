import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { detectGroupKey } from "../components/Badge";
import EmptyState from "../components/EmptyState";
import usePolling from "../hooks/usePolling";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconRadio,
  IconRefresh,
  IconSearch,
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
    category: String(source.liveTypeName || source.category || source.typeName || source.liveType || "直播"),
    startedAt: source.startTime || source.startedAt || source.ctime || null,
  };
}

function formatStartedAt(value, text = {}) {
  if (!value) return text.liveBadge;
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const raw = typeof numeric === "number" && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return text.liveBadge;
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function LiveCard({ live, onSelect, text }) {
  const groupKey = detectGroupKey(live.teamName || live.groupName || live.memberName || live.title);
  const placeholderTone = groupKey ? `group-${groupKey}` : "";
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
            <div className={`cover-placeholder ${placeholderTone}`}>
              <div className="cover-placeholder-watermark">
                <IconRadio size={26} />
                {groupKey && <span className="cover-placeholder-group">{groupKey.toUpperCase()}48</span>}
              </div>
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
    joining: "正在连接直播…",
    joiningSlow: "连接时间比平时更长…",
    joiningHint: "正在获取播放地址，若长时间无响应可点击重试。",
    playerPrep: "正在准备播放器…",
    playerPrepSlow: "播放器准备时间比平时更长…",
    search: "搜索成员或标题…",
    refresh: "刷新列表",
    loading: "正在查找直播…",
    loadingSlow: "查找直播比平时更慢…",
    slowNote: "上游接口响应较慢，可稍候或手动重试。",
    listUnavailable: "直播列表暂时不可用",
    empty: "没有匹配的直播",
    none: "当前没有正在进行的直播",
    emptyHint: "换一个关键词，或清空搜索。",
    noneHint: "成员开播后会自动显示在这里。",
    onAirHeading: "正在直播",
    moreOnAir: "其他正在直播",
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
    joining: "Connecting to the live…",
    joiningSlow: "Connecting is taking longer than usual…",
    joiningHint: "Fetching the play address. If nothing happens, try again.",
    playerPrep: "Preparing the player…",
    playerPrepSlow: "Preparing the player is taking longer than usual…",
    search: "Search members or titles…",
    refresh: "Refresh the list",
    loading: "Finding lives…",
    loadingSlow: "Finding lives is taking longer than usual…",
    slowNote: "The upstream live API is responding slowly.",
    listUnavailable: "The live list is unavailable right now",
    empty: "No live matches your search",
    none: "Nothing is on air right now",
    emptyHint: "Try another keyword or clear the search.",
    noneHint: "Lives appear here when a member goes on air.",
    onAirHeading: "Live now",
    moreOnAir: "Other live streams",
  },
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
  const [loading, setLoading] = useState(true);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [playerError, setPlayerError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const playerRequestRef = useRef(0);

  const loadLives = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const liveResponse = await publicApi.get("/live");
      setLives(
        listPayload(liveResponse, ["liveList", "lives", "items", "content"])
          .map((item) => normalizeLive(item, t))
          .filter((item) => item.liveId)
      );
      setListError("");
    } catch (requestError) {
      setListError(errorMessage(requestError, t.listError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

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

  const visibleLives = useMemo(
    () => (liveId ? filteredLives.filter((item) => item.liveId !== String(liveId)) : filteredLives),
    [filteredLives, liveId]
  );

  function selectLive(live) {
    setSelected(live);
    setStream(null);
    setPlayerError("");
    navigate(`/live/${encodeURIComponent(live.liveId)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="public-site">
      <PublicMediaTabs active="live" liveCount={lives.length} />

      <main className="public-main">
        {liveId && (
          <section className="featured-live">
            <div className="featured-topbar">
              <button className="back-link" onClick={() => navigate("/")}>
                <IconArrowLeft size={15} /> 返回列表
              </button>
            </div>
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
                <IconAlertCircle size={28} color="var(--danger)" />
                <strong>{t.cannotPlayTitle}</strong>
                <span>{playerError}</span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadPlay(liveId)}
                >
                  <IconRefresh size={14} /> 重试
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
                      <span className="badge badge-recording">LIVE</span>
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

        {(!liveId || visibleLives.length > 0) && (
          <section className="public-list-section">
            {liveId ? (
              <div className="public-more-divider">
                <span>{t.moreOnAir}</span>
              </div>
            ) : (
              <div className="public-filter-row">
                <div className="public-heading-inline">
                  <h1>{t.onAirHeading}</h1>
                  {lives.length > 0 && <span className="badge badge-default">{lives.length}</span>}
                </div>
                <div className="public-toolbar-right">
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
            )}

            {listError && visibleLives.length > 0 && (
              <div className="public-alert" role="status">
                <IconAlertCircle size={15} />
                <span>列表可能不是最新：{listError}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadLives()}
                >
                  重试
                </button>
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
            ) : listError && visibleLives.length === 0 ? (
              <EmptyState
                icon={IconAlertCircle}
                title={t.listUnavailable}
                detail={listError}
                action={
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => loadLives()}
                  >
                    <IconRefresh size={14} /> 立即重试
                  </button>
                }
              />
            ) : visibleLives.length > 0 ? (
              <div className="public-live-grid">
                {visibleLives.map((live) => (
                  <LiveCard key={live.liveId} live={live} onSelect={selectLive} text={t} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={IconRadio}
                title={searchQuery ? t.empty : t.none}
                detail={searchQuery ? t.emptyHint : t.noneHint}
                action={
                  searchQuery ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setSearchQuery("")}
                    >
                      清除搜索
                    </button>
                  ) : (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => loadLives()}
                    >
                      <IconRefresh size={14} /> 刷新
                    </button>
                  )
                }
              />
            )}
          </section>
        )}
      </main>
    </div>
  );
}

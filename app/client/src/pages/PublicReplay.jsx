import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { detectGroupKey } from "../components/Badge";
import EmptyState from "../components/EmptyState";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCopy,
  IconDownload,
  IconFilm,
  IconRadio,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTv,
} from "../components/Icons";
import LoadingState from "../components/LoadingState";
import PublicMediaTabs from "../components/PublicMediaTabs";
import SafeImage from "../components/SafeImage";
import VideoPlayer from "../components/VideoPlayer";
import useReplayLayout from "../hooks/useReplayLayout";
import { errorMessage, payload, publicApi } from "../lib/api";
import {
  REPLAY_GROUPS,
  replayFilterLabel,
  replayGroup,
} from "../lib/replayGroups";
import "./PublicReplay.css";

const TEXT = {
  zh: {
    types: { 5: "游戏直播", 6: "AI 直播" },
    category: { fallback: "视频直播" },
    layout: { label: "观看版式", portrait: "竖屏", landscape: "横屏" },
    share: { idle: "复制回放链接", copied: "链接已复制", failed: "复制失败，请复制地址栏链接" },
    page: {
      heading: "往期公开重播",
      moreHeading: "更多近期重播",
      groupFilter: "重播团体筛选",
      search: "搜索成员名字或重播标题…",
      preparing: "正在准备重播列表…",
      preparingSlow: "重播列表加载比平时更慢…",
      note: "上游回放接口响应较慢，可稍候或点击重试。",
      unavailable: "重播列表暂时不可用",
      empty: "没有符合条件的公开重播",
      none: "当前没有可观看的公开重播",
      emptyHint: "尝试切换分团或更换关键词。",
      noneHint: "稍后再来查看近期公开重播。",
      listError: "重播列表加载失败",
    },
    detail: {
      memberLive: "成员直播回放", member: "口袋48成员", timeUnknown: "开播时间未知",
      noPlayUrl: "播放接口没有返回播放地址", badProtocol: "播放接口返回了不支持的协议",
      cannotPlay: "这条重播暂时无法播放", infoError: "回放信息加载失败",
      prep: "正在获取重播流…", prepSlow: "获取重播流比平时更慢…",
      prepHint: "正在获取回放流地址，若无响应可点击重试。",
      playerPrep: "正在准备播放器…", playerPrepSlow: "播放器准备时间比平时更长…",
    },
    download: {
      statusError: "下载状态读取失败", unavailable: "这条重播暂时无法下载", downloadFile: "保存 MP4", downloadVideo: "下载视频",
      fetching: "正在拉取分片…",
      packing: "正在封装校验…", packingHint: "分片已就绪，正在封装 MP4…",
      readyHint: "MP4 已就绪",
    },
    words: { live: "直播", video: "视频", radio: "电台" },
  },
  en: {
    types: { 5: "Game live", 6: "AI live" },
    category: { fallback: "Video live" },
    layout: { label: "Player layout", portrait: "Portrait", landscape: "Landscape" },
    share: { idle: "Copy replay link", copied: "Link copied", failed: "Copy failed — use the address bar" },
    page: {
      heading: "Public replays",
      moreHeading: "More recent replays",
      groupFilter: "Filter replays by group",
      search: "Search member name or replay title…",
      preparing: "Loading replays…",
      preparingSlow: "Loading replays is taking longer than usual…",
      note: "The upstream replay service is responding slowly.",
      unavailable: "Replays are unavailable right now",
      empty: "No public replay matches your filter",
      none: "No public replays are available right now",
      emptyHint: "Try another group or keyword.",
      noneHint: "Check back later for recent public replays.",
      listError: "Could not load replays",
    },
    detail: {
      memberLive: "Member live replay", member: "Pocket48 member", timeUnknown: "Start time unknown",
      noPlayUrl: "The play API returned no playUrl", badProtocol: "The play API returned an unsupported protocol",
      cannotPlay: "This replay cannot be played right now", infoError: "Could not load replay details",
      prep: "Fetching replay stream…", prepSlow: "Fetching the replay stream is taking longer than usual…",
      prepHint: "Requesting the replay address. Try again if it stalls.",
      playerPrep: "Preparing the player…", playerPrepSlow: "Preparing the player is taking longer than usual…",
    },
    download: {
      statusError: "Download status is unavailable", unavailable: "This replay cannot be downloaded right now", downloadFile: "Save MP4", downloadVideo: "Download video",
      fetching: "Downloading segments…",
      packing: "Packaging…", packingHint: "Packaging and verifying MP4…",
      readyHint: "MP4 ready",
    },
    words: { live: "Live", video: "Video", radio: "Radio" },
  },
};

export function languageOf(languages) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return typeof first === "string" && /^en\b/i.test(first) ? "en" : "zh";
}

function replayCategory(source, t = TEXT.zh) {
  const type = Number(source.liveType);
  const named = String(source.liveTypeName || source.category || source.typeName || "");
  if (type === 2 || named.includes("电台")) return "电台直播";
  if (type === 1 || named.includes("视频") || named.includes("直播")) return "视频直播";
  if (named) return named.replace(/重播$/, "直播");
  return t.types[type] || t.category.fallback;
}

function normalizeReplay(item = {}, t = TEXT.zh) {
  const source = item.content || item.replay || item.live || item;
  const user = source.userInfo || source.member || source.user || {};
  return {
    ...source,
    replayId: String(source.replayId ?? source.id ?? source.liveId ?? source.replay_id ?? item.replayId ?? ""),
    title: source.title || source.liveTitle || source.roomName || t.detail.memberLive,
    memberName: user.nickname || user.name || source.memberName || source.nickname || t.detail.member,
    avatar: user.avatar || user.avatarUrl || source.avatar || "",
    cover: source.cover || source.coverUrl || source.thumb || source.image || "",
    category: replayCategory(source, t),
    startedAt: source.startTime || source.startedAt || source.ctime || source.createdAt || null,
    duration: source.duration ?? source.durationSeconds ?? source.liveDuration ?? source.timeLength ?? null,
    teamId: String(source.team?.id || source.teamId || ""),
    teamName: source.team?.name || source.teamName || "",
  };
}

function replayPage(response) {
  const body = payload(response, {});
  const page = body?.data && !Array.isArray(body.data) ? body.data : body;
  const items = Array.isArray(page) ? page : page?.items || page?.replays || page?.list || page?.content || [];
  const next = Array.isArray(page) ? null : page?.next ?? page?.nextCursor ?? null;
  const hasNextCursor = next !== null && next !== undefined && String(next) !== "" && String(next) !== "0";
  const hasMore = Array.isArray(page) ? false : typeof page?.hasMore === "boolean" ? page.hasMore && hasNextCursor : hasNextCursor;
  return {
    items: Array.isArray(items) ? items.map((item) => normalizeReplay(item)).filter((item) => item.replayId) : [],
    next,
    hasMore,
    search: Array.isArray(page) ? null : page?.search || null,
  };
}

function formatReplayTime(value, t = TEXT.zh) {
  if (!value) return t.detail.timeUnknown;
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const raw = typeof numeric === "number" && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return t.detail.timeUnknown;
  const nowYear = new Date().getFullYear();
  const y = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return y === nowYear ? `${mm}-${dd} ${hh}:${mi}` : `${y}-${mm}-${dd} ${hh}:${mi}`;
}

function formatDuration(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && value.includes(":")) return value;
  let seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds > 86_400_000) seconds /= 1000;
  seconds = Math.round(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function shortCategoryLabel(category) {
  if (!category) return "";
  if (category === "视频直播") return "视频";
  if (category === "电台直播") return "电台";
  if (category === "游戏直播") return "游戏";
  if (category === "AI 直播") return "AI";
  return category;
}

function downloadLabel(state, t = TEXT.zh) {
  if (state.status === "preparing") return `下载分片 ${state.progress || 0}%`;
  if (state.status === "verifying") return t.download.packing;
  if (state.status === "ready") return t.download.downloadFile;
  return t.download.downloadVideo;
}

function downloadNote(state, t = TEXT.zh) {
  if (state.status === "preparing") return t.download.fetching;
  if (state.status === "verifying") return t.download.packingHint;
  if (state.status === "ready") return t.download.readyHint;
  return "";
}

function useReplayDownload(replayId, t) {
  const { replayId: routeReplayId } = useParams();
  const [download, setDownload] = useState({ status: "idle", progress: 0, error: "" });
  const timerRef = useRef(null);
  const requestRef = useRef(null);
  const scopeRef = useRef(null);

  useEffect(() => {
    const scope = {};
    scopeRef.current = scope;
    setDownload({ status: "idle", progress: 0, error: "" });
    return () => {
      scopeRef.current = null;
      requestRef.current?.abort();
      requestRef.current = null;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [replayId, routeReplayId]);

  const startDownload = useCallback(async () => {
    const scope = scopeRef.current;
    if (!replayId || !scope || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const ownsRequest = () => scopeRef.current === scope && !controller.signal.aborted && requestRef.current === controller;
    const finish = () => { if (ownsRequest()) requestRef.current = null; };
    const fail = (error, fallback) => {
      if (!ownsRequest()) return;
      setDownload({ status: "failed", progress: 0, error: errorMessage(error, fallback) });
      finish();
    };
    window.clearTimeout(timerRef.current);
    setDownload({ status: "preparing", progress: 0, error: "" });
    try {
      await publicApi.post(`/replays/${encodeURIComponent(replayId)}/download`, {}, { signal: controller.signal });
      if (!ownsRequest()) return;
      const poll = async () => {
        if (!ownsRequest()) return;
        try {
          const response = await publicApi.get(`/replays/${encodeURIComponent(replayId)}/download/status`, { signal: controller.signal });
          if (!ownsRequest()) return;
          const state = payload(response, {});
          setDownload(state);
          if (state.status === "ready") {
            finish();
            window.location.href = `/api/public/replays/${encodeURIComponent(replayId)}/download`;
          } else if (state.status === "failed") {
            finish();
          } else {
            timerRef.current = window.setTimeout(poll, 1000);
          }
        } catch (error) {
          fail(error, t.download.statusError);
        }
      };
      await poll();
    } catch (error) {
      fail(error, t.download.unavailable);
    }
  }, [replayId, t]);

  return [download, startDownload];
}

function ReplayCard({ replay, onSelect, groupHint = "", t = TEXT.zh }) {
  const [download, requestDownload] = useReplayDownload(replay.replayId, t);
  const duration = formatDuration(replay.duration);
  const isRadio = replay.category.includes("电台") || replay.category.toLowerCase().includes("radio");
  const isVideo = replay.category.includes("视频") || replay.category.toLowerCase().includes("video");
  const typeClass = isRadio ? "radio" : isVideo ? "video" : "other";
  const groupKey = detectGroupKey(replay.teamName || replay.groupName || groupHint || replay.memberName);
  const placeholderTone = groupKey ? `group-${groupKey}` : "";
  const isBusy = ["preparing", "verifying"].includes(download.status);
  const label = downloadLabel(download, t);

  function startDownload(event) {
    event.stopPropagation();
    void requestDownload();
  }

  return (
    <article className="public-live-card replay-card">
      <button
        type="button"
        className="replay-card-main"
        onClick={() => onSelect(replay)}
        aria-label={`观看 ${replay.memberName} 的直播回放：${replay.title}`}
      >
        <div className="live-cover replay-cover">
          <SafeImage
            src={replay.cover}
            alt=""
            loading="lazy"
            fallback={
              <div className={`cover-placeholder ${placeholderTone}`}>
                <div className="cover-placeholder-watermark">
                  {isRadio ? <IconRadio size={26} /> : <IconFilm size={26} />}
                  {groupKey && <span className="cover-placeholder-group">{groupKey.toUpperCase()}48</span>}
                </div>
              </div>
            }
          />
          <span className={`replay-type-pill ${typeClass}`}>
            <span>{shortCategoryLabel(replay.category)}</span>
          </span>
          {duration && <span className="replay-duration">{duration}</span>}
        </div>
        <div className="live-card-body">
          <div className="member-avatar">
            <SafeImage
              src={replay.avatar}
              alt=""
              loading="lazy"
              fallback={<span>{replay.memberName.slice(0, 1)}</span>}
            />
          </div>
          <div className="live-copy">
            <strong>{replay.title}</strong>
            <span>
              {replay.memberName} · {formatReplayTime(replay.startedAt, t)}
            </span>
          </div>
        </div>
      </button>
      <button
        type="button"
        className={`replay-card-dl-btn ${isBusy ? "is-busy" : ""}`}
        onClick={startDownload}
        disabled={isBusy}
        aria-label={label}
        title={label}
      >
        <IconDownload size={14} />
        {isBusy && <span>{download.status === "preparing" ? `${download.progress || 0}%` : "…"}</span>}
      </button>
      {download.error && <div className="replay-card-download-error" role="status">{download.error}</div>}
    </article>
  );
}

function formatSummaryTime(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function PublicReplaySummary({ value }) {
  const chapters = Array.isArray(value.chapters) ? value.chapters : [];
  const highlights = Array.isArray(value.highlights) ? value.highlights : [];
  return (
    <div className="public-replay-summary" aria-label="重播内容总结">
      <div className="public-replay-summary-head">
        <IconSparkles size={16} />
        <strong>内容总结</strong>
        <span className="public-replay-summary-note">AI 生成，仅供参考</span>
      </div>
      {value.summary ? <p className="public-replay-summary-text">{value.summary}</p> : <p className="public-replay-summary-note">这条回放只公开章节与时间。</p>}
      {chapters.length > 0 && (
        <ol className="public-replay-summary-list">
          {chapters.map((item, index) => (
            <li key={`c${index}`}>
              <strong>{item.title || "未命名章节"}</strong>
              {Number.isFinite(item.start) && <time>{formatSummaryTime(item.start)}{Number.isFinite(item.end) ? ` – ${formatSummaryTime(item.end)}` : ""}</time>}
              {item.summary && <span>{item.summary}</span>}
            </li>
          ))}
        </ol>
      )}
      {highlights.length > 0 && (
        <ol className="public-replay-summary-list is-highlight">
          {highlights.map((item, index) => (
            <li key={`h${index}`}>
              <strong>{item.title || "精彩片段"}</strong>
              {Number.isFinite(item.start) && <time>{formatSummaryTime(item.start)}{Number.isFinite(item.end) ? ` – ${formatSummaryTime(item.end)}` : ""}</time>}
              {item.summary && <span>{item.summary}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function PublicReplayPage() {
  const t = TEXT[languageOf(typeof navigator === "undefined" ? "zh" : navigator.languages || navigator.language)];
  const { replayId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [replays, setReplays] = useState([]);
  const [selected, setSelected] = useState(() =>
    location.state?.replay ? normalizeReplay(location.state.replay, t) : null
  );
  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [next, setNext] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [searchInfo, setSearchInfo] = useState(null);
  const [listError, setListError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [summary, setSummary] = useState(null);
  const [shareState, setShareState] = useState("idle");
  const { layout, setLayout } = useReplayLayout();

  async function copyShareLink() {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const area = document.createElement("textarea");
        area.value = url;
        area.setAttribute("readonly", "");
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setShareState("copied");
    } catch {
      setShareState("failed");
    }
  }

  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState("");
  // Resume support: the last reported playback position, and the position the
  // next successful (re)load should seek to. Only the fetch-retry path sets a
  // non-zero seek, so normal episode switches never rewind.
  const [pendingSeek, setPendingSeek] = useState(0);
  const playbackPositionRef = useRef(0);
  const [downloadState, requestDownload] = useReplayDownload(replayId, t);
  const [groupId, setGroupId] = useState("all");
  const [teamId, setTeamId] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const playerRequestRef = useRef(0);

  const loadReplays = useCallback(
    async ({ append = false, cursor = null, group = "all", team = "all", memberName = "" } = {}) => {
      const requestId = ++listRequestRef.current;
      if (append) {
        setLoadingMore(true);
        setMoreError("");
      } else {
        setLoading(true);
        setListError("");
        setMoreError("");
        setReplays([]);
        setNext(null);
        setHasMore(false);
        setSearchInfo(null);
      }
      try {
        const params = {};
        if (cursor) params.next = cursor;
        if (group !== "all") params.groupId = group;
        if (group !== "all" && team !== "all") params.teamId = team;
        if (memberName) params.memberName = memberName;
        const response = await publicApi.get("/replays", {
          params: Object.keys(params).length ? params : undefined,
          // Group/team and member searches page the upstream serially (up to
          // 12 hops), which cannot fit the 15s instance default.
          timeout: 30000,
        });
        if (requestId !== listRequestRef.current) return;
        const page = replayPage(response);
        setReplays((current) => {
          if (!append) return page.items;
          const merged = new Map(current.map((item) => [item.replayId, item]));
          page.items.forEach((item) => merged.set(item.replayId, item));
          return Array.from(merged.values());
        });
        setNext(page.next);
        setHasMore(page.search?.applied ? false : page.hasMore);
        setSearchInfo(page.search);
      } catch (requestError) {
        if (requestId !== listRequestRef.current) return;
        const message = errorMessage(requestError, t.page.listError);
        if (append) setMoreError(message);
        else setListError(message);
      } finally {
        if (requestId === listRequestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    const memberName = searchQuery.trim();
    const timer = window.setTimeout(
      () => loadReplays({ group: groupId, team: teamId, memberName }),
      memberName ? 350 : 0
    );
    return () => {
      window.clearTimeout(timer);
      listRequestRef.current += 1;
    };
  }, [loadReplays, groupId, teamId, searchQuery]);

  const loadPlay = useCallback(async (id) => {
    const requestId = ++playerRequestRef.current;
    setPlayerLoading(true);
    setPlayerError("");
    setStream(null);
    try {
      const response = await publicApi.get(
        `/replays/${encodeURIComponent(id)}/play`
      );
      if (requestId !== playerRequestRef.current) return;
      const playBody = payload(response, {});
      const play = playBody?.play || playBody;
      const protocol = String(play.protocol || "").toLowerCase();
      if (!play.playUrl) throw new Error(t.detail.noPlayUrl);
      if (protocol !== "hls" && protocol !== "flv")
        throw new Error(t.detail.badProtocol);
      setStream({ ...play, type: protocol, proxyUrl: play.playUrl });
    } catch (requestError) {
      if (requestId === playerRequestRef.current) {
        setPlayerError(errorMessage(requestError, t.detail.cannotPlay));
      }
    } finally {
      if (requestId === playerRequestRef.current) setPlayerLoading(false);
    }
  }, []);

  // Fetch-retry path (重新获取/重试): remember where playback stood so the
  // remounted player can seek straight back instead of restarting at 0:00.
  function retryPlay() {
    setPendingSeek(Math.max(0, playbackPositionRef.current || 0));
    loadPlay(replayId);
  }

  useEffect(() => {
    if (!replayId) {
      detailRequestRef.current += 1;
      playerRequestRef.current += 1;
      setSelected(null);
      setStream(null);
      setDetailError("");
      setPlayerError("");
      setPlayerLoading(false);
      setShareState("idle");
      setPendingSeek(0);
      playbackPositionRef.current = 0;
      return undefined;
    }

    const id = String(replayId);
    setShareState("idle");
    setPendingSeek(0);
    playbackPositionRef.current = 0;
    const routeReplay = location.state?.replay
      ? normalizeReplay(location.state.replay, t)
      : null;
    setSelected((current) =>
      current?.replayId === id
        ? current
        : routeReplay?.replayId === id
        ? routeReplay
        : null
    );
    setDetailError("");
    const detailRequestId = ++detailRequestRef.current;
    setSummary(null);
    publicApi
      .get(`/replays/${encodeURIComponent(id)}/summary`)
      .then((response) => {
        if (detailRequestId !== detailRequestRef.current) return;
        const body = payload(response, {});
        const hasProse = typeof body?.summary === "string" && body.summary.trim();
        const hasChapters =
          (Array.isArray(body?.chapters) && body.chapters.length > 0) ||
          (Array.isArray(body?.highlights) && body.highlights.length > 0);
        if (body && (hasProse || hasChapters)) setSummary(body);
      })
      .catch(() => undefined);
    publicApi
      .get(`/replays/${encodeURIComponent(id)}`)
      .then((response) => {
        if (detailRequestId !== detailRequestRef.current) return;
        const detailBody = payload(response, {});
        setSelected(
          normalizeReplay(
            detailBody?.replay || detailBody?.item || detailBody,
            t
          )
        );
      })
      .catch((requestError) => {
        if (detailRequestId === detailRequestRef.current) {
          setDetailError(errorMessage(requestError, t.detail.infoError));
        }
      });
    loadPlay(id);

    return () => {
      detailRequestRef.current += 1;
      playerRequestRef.current += 1;
    };
  }, [replayId, location.state, loadPlay]);

  const selectedGroup = useMemo(() => replayGroup(groupId), [groupId]);
  const filterLabel = useMemo(
    () => replayFilterLabel(groupId, teamId),
    [groupId, teamId]
  );
  const filtersActive = groupId !== "all";

  function handleGroupTabClick(gId) {
    setGroupId(gId);
    setTeamId("all");
  }

  function resetFilters() {
    setGroupId("all");
    setTeamId("all");
    setSearchQuery("");
  }

  function selectReplay(replay) {
    setSelected(replay);
    setStream(null);
    setDetailError("");
    setPlayerError("");
    navigate(`/replays/${encodeURIComponent(replay.replayId)}`, {
      state: { replay },
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const selectedDuration = selected ? formatDuration(selected.duration) : "";
  const activeDownloadHint = downloadState.error || downloadNote(downloadState, t);

  const filteredReplays = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return replays;
    return replays.filter(
      (item) =>
        item.memberName.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    );
  }, [replays, searchQuery]);

  return (
    <div className="public-site">
      <PublicMediaTabs active="replay" />

      <main className="public-main">
        {replayId && (
          <section className={`featured-live featured-replay replay-layout-${layout}`}>
            <div className="featured-topbar">
              <button className="back-link" onClick={() => navigate("/replays")}>
                <IconArrowLeft size={15} /> 返回列表
              </button>
              <div className="replay-layout-toolbar" role="group" aria-label={t.layout.label}>
                <span className="replay-layout-toolbar-label">{t.layout.label}</span>
                {["portrait", "landscape"].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-pressed={layout === value}
                    onClick={() => setLayout(value)}
                  >
                    {t.layout[value]}
                  </button>
                ))}
              </div>
            </div>

            <div className="replay-detail-columns">
              <div className="replay-detail-player replay-stage">
                {playerLoading ? (
                  <LoadingState
                    text={t.detail.prep}
                    slowText={t.detail.prepSlow}
                    slowAfterMs={8000}
                    slowHint={t.detail.prepHint}
                    onRetry={retryPlay}
                  />
                ) : playerError ? (
                  <div className="player-request-error" role="alert">
                    <IconAlertCircle size={28} color="var(--danger)" />
                    <strong>重播暂时无法播放</strong>
                    <span>{playerError}</span>
                    <button className="btn btn-secondary btn-sm" onClick={retryPlay}>
                      <IconRefresh size={14} /> 重试
                    </button>
                  </div>
                ) : stream?.proxyUrl ? (
                  <VideoPlayer
                    mode="replay"
                    stream={stream}
                    poster={selected?.cover}
                    title={selected?.title}
                    startAt={pendingSeek}
                    onLoadedMetadata={() => setPendingSeek(0)}
                    onTimeUpdate={(event) => {
                      playbackPositionRef.current = Number(event?.target?.currentTime) || 0;
                    }}
                    onRetry={retryPlay}
                  />
                ) : (
                  <LoadingState text={t.detail.playerPrep} slowText={t.detail.playerPrepSlow} slowAfterMs={8000} />
                )}
              </div>

              <div className="replay-detail-info">
                {selected && (
                  <div className="featured-meta">
                    <div className="featured-heading">
                      <span className="badge badge-queued">
                        {shortCategoryLabel(selected.category)}
                      </span>
                      <h1>{selected.title}</h1>
                    </div>
                    <p>
                      <strong>{selected.memberName}</strong>
                      <span>·</span>
                      <span>{formatReplayTime(selected.startedAt, t)}</span>
                      {selectedDuration && (
                        <>
                          <span>·</span>
                          <span>{selectedDuration}</span>
                        </>
                      )}
                    </p>
                    <div className="featured-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={requestDownload}
                        disabled={["preparing", "verifying"].includes(downloadState.status)}
                      >
                        <IconDownload size={14} />
                        {downloadLabel(downloadState, t)}
                      </button>
                      {downloadState.status === "ready" && (
                        <a
                          className="btn btn-secondary btn-sm"
                          href={`/api/public/replays/${encodeURIComponent(selected.replayId)}/download`}
                          download
                        >
                          <IconDownload size={14} /> 下载文件
                        </a>
                      )}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={copyShareLink}>
                        <IconCopy size={13} />
                        {shareState === "copied" ? t.share.copied : shareState === "failed" ? t.share.failed : t.share.idle}
                      </button>
                      {activeDownloadHint && (
                        <span className="featured-action-note">{activeDownloadHint}</span>
                      )}
                    </div>
                    {detailError && (
                      <div className="detail-note" role="status">
                        {detailError}，当前显示列表中的信息。
                      </div>
                    )}
                  </div>
                )}
                {summary && <PublicReplaySummary value={summary} />}
                {!selected && detailError && (
                  <div className="detail-note" role="alert">{detailError}</div>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="public-list-section">
          {replayId ? (
            <div className="public-more-divider">
              <span>{t.page.moreHeading}</span>
            </div>
          ) : (
            <>
              <div className="public-filter-row">
                <div className="public-heading-inline">
                  <h1>{t.page.heading}</h1>
                </div>
                <div className="public-toolbar-right">
                  <div className="search-input-shell">
                    <IconSearch size={15} />
                    <input
                      type="text"
                      placeholder={t.page.search}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="replay-filter-bar" aria-label={t.page.groupFilter}>
                <div className="group-tabs-list">
                  <button
                    type="button"
                    className={`group-tab-btn ${groupId === "all" ? "active" : ""}`}
                    onClick={() => handleGroupTabClick("all")}
                  >
                    全部
                  </button>
                  {REPLAY_GROUPS.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={`group-tab-btn ${groupId === g.id ? "active" : ""}`}
                      onClick={() => handleGroupTabClick(g.id)}
                    >
                      {g.name}
                    </button>
                  ))}
                  {selectedGroup && selectedGroup.teams.length > 0 && (
                    <div className="team-select-shell">
                      <select
                        aria-label="选择队伍"
                        value={teamId}
                        onChange={(e) => setTeamId(e.target.value)}
                      >
                        <option value="all">全部队伍</option>
                        {selectedGroup.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {(filtersActive || searchQuery) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={resetFilters}
                  >
                    重置筛选
                  </button>
                )}
              </div>
            </>
          )}

          {!replayId && searchInfo?.applied && !loading && (
            <p className="search-result-note">
              「{searchInfo.members.map((member) => member.memberName).join("、")}」最近 {replays.length} 场重播
            </p>
          )}

          {listError && !loading && (
            <div className="public-alert" role="alert">
              <IconAlertCircle size={15} />
              <span>{listError}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  loadReplays({
                    group: groupId,
                    team: teamId,
                    memberName: searchQuery.trim(),
                  })
                }
              >
                重试
              </button>
            </div>
          )}

          {loading ? (
            <LoadingState
              text={t.page.preparing}
              slowText={t.page.preparingSlow}
              slowAfterMs={6000}
              slowHint={t.page.note}
              onRetry={() =>
                loadReplays({
                  group: groupId,
                  team: teamId,
                  memberName: searchQuery.trim(),
                })
              }
            />
          ) : filteredReplays.length > 0 ? (
            <>
              <div className="public-live-grid">
                {filteredReplays.map((replay) => (
                  <ReplayCard
                    key={replay.replayId}
                    replay={replay}
                    onSelect={selectReplay}
                    groupHint={selectedGroup?.name || ""}
                    t={t}
                  />
                ))}
              </div>
              {hasMore && (
                <div className="replay-pagination">
                  {moreError && (
                    <p className="search-result-note">{moreError}</p>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={loadingMore}
                    onClick={() =>
                      loadReplays({
                        append: true,
                        cursor: next,
                        group: groupId,
                        team: teamId,
                        memberName: searchQuery.trim(),
                      })
                    }
                  >
                    {loadingMore ? "加载中…" : "加载更多"}
                  </button>
                </div>
              )}
            </>
          ) : !listError ? (
            <EmptyState
              icon={IconTv}
              title={
                filtersActive || searchQuery
                  ? `${filterLabel} · ${t.page.empty}`
                  : t.page.none
              }
              detail={
                filtersActive || searchQuery
                  ? searchInfo?.applied
                    ? `未找到“${searchQuery.trim()}”的公开重播。`
                    : t.page.emptyHint
                  : t.page.noneHint
              }
              action={
                filtersActive || searchQuery ? (
                  <button className="btn btn-secondary btn-sm" onClick={resetFilters}>
                    清除筛选
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => loadReplays()}
                  >
                    <IconRefresh size={14} /> 刷新
                  </button>
                )
              }
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

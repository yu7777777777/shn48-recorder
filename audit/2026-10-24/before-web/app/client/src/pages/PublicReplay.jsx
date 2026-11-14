import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LoadingState from "../components/LoadingState";
import PublicMediaTabs from "../components/PublicMediaTabs";
import SafeImage from "../components/SafeImage";
import VideoPlayer from "../components/VideoPlayer";
import { errorMessage, payload, publicApi } from "../lib/api";
import { REPLAY_GROUPS, replayFilterLabel, replayGroup } from "../lib/replayGroups";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import useReplayLayout from "../hooks/useReplayLayout";
import "./PublicReplay.css";
import EmptyState from "../components/EmptyState";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFilm,
  IconRadio,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTv,
} from "../components/Icons";

const TEXT = {
  zh: {
    layout: { label: "观看版式", portrait: "竖屏", landscape: "横屏" },
    export: { label: "多版本导出", landscape: "横屏", portrait: "竖屏", audio: "仅音频", action: "导出所选版本", unavailable: "横屏、竖屏及仅音频转码尚未接入后端，暂不可导出；上方下载视频保留原始 MP4，不受观看版式影响。" },
    types: { 1: "视频直播", 2: "电台直播", 5: "游戏直播", 6: "AI 直播" },
    category: { radio: "电台直播", video: "视频直播", fallback: "视频直播" },
    share: { copied: "链接已复制", failed: "复制失败，请手动复制地址栏", idle: "复制回放链接" },
    summary: { label: "重播内容总结", note: "AI 生成，仅供参考" },
    page: {
      loading: "正在加载…", retryMore: "重试加载更多", loadMore: "加载更多重播", refresh: "刷新重播",
      preparing: "正在整理往期重播…", preparingSlow: "正在整理往期重播，比平时慢一些…",
      note: "重播列表来自口袋48，搜索或切换分组会重新拉取，页面会保持等待。",
      search: "搜索成员或标题…", groupFilter: "重播分组筛选",
      empty: "未找到符合筛选条件的重播", none: "暂时没有可观看的往期重播",
      emptyHint: "可以切换其他队伍，或清除筛选条件查看全部重播。", noneHint: "口袋48有成员公开回放后会显示在这里。",
      listError: "往期重播暂时无法获取",
    },
    detail: {
      infoError: "重播信息暂时无法获取", member: "口袋48成员", memberLive: "成员直播", timeUnknown: "时间待更新",
      noPlayUrl: "播放接口未返回 playUrl", badProtocol: "播放接口返回了不支持的协议", cannotPlay: "这段重播暂时无法播放",
      playerPrep: "正在准备播放器…", playerPrepSlow: "正在准备播放器，比平时慢一些…",
      prep: "正在准备重播…", prepSlow: "正在准备重播，比平时慢一些…",
      prepHint: "正在向口袋48获取重播地址，若长时间没有反应可重新获取。",
    },
    download: {
      statusError: "下载状态暂时无法获取", unavailable: "回放暂时无法下载", downloadFile: "下载文件", downloadVideo: "下载视频",
      fetching: "正在下载官方回放分片", fetchingHint: "首次下载会先整理完整回放，可能需要一些时间",
      packing: "正在封装并校验…", packingHint: "分片已下载完成，正在封装并校验视频，完成后即可下载",
      readyHint: "视频已准备完成，点击下载文件即可保存 MP4",
    },
    service: { online: "服务在线", checking: "服务检查中" },
    words: { live: "直播", video: "视频", radio: "电台" },
  },
  en: {
    layout: { label: "Viewing layout", portrait: "Portrait", landscape: "Landscape" },
    export: { label: "Multi-version export", landscape: "Landscape", portrait: "Portrait", audio: "Audio only", action: "Export selected version", unavailable: "Landscape, portrait and audio-only conversion is not connected to the backend yet. Use Download video above for the original MP4; viewing layout does not change the file." },
    types: { 1: "Video live", 2: "Radio live", 5: "Game live", 6: "AI live" },
    category: { radio: "Radio live", video: "Video live", fallback: "Video live" },
    share: { copied: "Link copied", failed: "Copy failed, select the address bar", idle: "Copy replay link" },
    summary: { label: "Replay summary", note: "AI generated, for reference only" },
    page: {
      loading: "Loading…", retryMore: "Retry loading more", loadMore: "Load more replays", refresh: "Refresh replays",
      preparing: "Gathering past replays…", preparingSlow: "Gathering past replays is taking longer than usual…",
      note: "The list comes from Pocket48. Searching or switching groups fetches again and the page keeps waiting.",
      search: "Search members or titles…", groupFilter: "Replay group filter",
      empty: "No replay matches these filters", none: "No past replays to watch yet",
      emptyHint: "Switch to another team, or clear the filters to see every replay.", noneHint: "Replays appear here once Pocket48 members publish them.",
      listError: "Past replays are unavailable right now",
    },
    detail: {
      infoError: "Replay details are unavailable right now", member: "Pocket48 member", memberLive: "Member live", timeUnknown: "Time not published yet",
      noPlayUrl: "The play API returned no playUrl", badProtocol: "The play API returned an unsupported protocol", cannotPlay: "This replay cannot be played right now",
      playerPrep: "Preparing the player…", playerPrepSlow: "Preparing the player is taking longer than usual…",
      prep: "Preparing the replay…", prepSlow: "Preparing the replay is taking longer than usual…",
      prepHint: "Fetching the replay address from Pocket48. If nothing happens, try again.",
    },
    download: {
      statusError: "Download status is unavailable", unavailable: "This replay cannot be downloaded right now", downloadFile: "Download file", downloadVideo: "Download video",
      fetching: "Downloading the official segments", fetchingHint: "The first download assembles the whole replay and can take a while",
      packing: "Packaging and verifying…", packingHint: "Segments are downloaded; packaging and verifying the video before download",
      readyHint: "The video is ready. Download the file to save the MP4",
    },
    service: { online: "Service online", checking: "Checking service" },
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
  return text.types[type] || text.category.fallback;
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
    category: replayCategory(source),
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
    items: Array.isArray(items) ? items.map(normalizeReplay).filter((item) => item.replayId) : [],
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
  return `${date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" })} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
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
  return t.download.fetchingHint;
}

function ReplayCard({ replay, onSelect, t = TEXT.zh }) {
  const [download, setDownload] = useState({ status: "idle", progress: 0, error: "" });
  const downloadTimer = useRef(null);
  const duration = formatDuration(replay.duration);
  const isRadio = replay.category.includes("电台");
  const isVideo = replay.category.includes("视频");
  const typeClass = isRadio ? "radio" : isVideo ? "video" : "other";

  useEffect(() => () => window.clearTimeout(downloadTimer.current), []);

  async function startDownload(event) {
    event.stopPropagation();
    if (["preparing", "verifying"].includes(download.status)) return;
    setDownload({ status: "preparing", progress: 0, error: "" });
    try {
      await publicApi.post(`/replays/${encodeURIComponent(replay.replayId)}/download`);
      const poll = async () => {
        try {
          const response = await publicApi.get(`/replays/${encodeURIComponent(replay.replayId)}/download/status`);
          const state = payload(response, {});
          setDownload(state);
          if (state.status === "ready") window.location.href = `/api/public/replays/${encodeURIComponent(replay.replayId)}/download`;
          else if (state.status !== "failed") downloadTimer.current = window.setTimeout(poll, 1000);
        } catch (error) {
          setDownload({ status: "failed", progress: 0, error: errorMessage(error, t.download.statusError) });
        }
      };
      await poll();
    } catch (error) {
      setDownload({ status: "failed", progress: 0, error: errorMessage(error, t.download.unavailable) });
    }
  }

  return (
    <article
      className="public-live-card replay-card"
    >
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
              <div className="cover-placeholder">
                <span>{replay.memberName.slice(0, 1)}</span>
              </div>
            }
          />
          <span className={`replay-type-pill ${typeClass}`}>
            {isRadio ? <IconRadio size={12} /> : isVideo ? <IconFilm size={12} /> : <IconTv size={12} />}
            <span>{replay.category}</span>
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
          <span className="card-action-icon" aria-hidden="true">
            <IconChevronRight size={18} />
          </span>
        </div>
      </button>
      <div className="replay-card-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={startDownload}
          disabled={["preparing", "verifying"].includes(download.status)}
        >
          <IconDownload size={13} />
          {downloadLabel(download, t)}
        </button>
      </div>
      {download.error && <div className="replay-card-download-error" role="status">{download.error}</div>}
    </article>
  );
}

// Public summary: title and text only. The model, endpoint and subtitle evidence are
// deliberately not rendered here, matching what the endpoint is allowed to return.
function PublicReplaySummary({ value, t = TEXT.zh }) {
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
              <strong>{item.title || '未命名章节'}</strong>
              {item.summary && <span>{item.summary}</span>}
            </li>
          ))}
        </ol>
      )}
      {highlights.length > 0 && (
        <ol className="public-replay-summary-list is-highlight">
          {highlights.map((item, index) => (
            <li key={`h${index}`}>
              <strong>{item.title || '精彩片段'}</strong>
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
  const [health, setHealth] = useState(null);
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
  const [exportVersion, setExportVersion] = useState("portrait");

  // Share the current page URL; the server already renders a link preview for
  // published replays, so the copied link is all a chat app needs.
  async function copyShareLink() {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); }
      else {
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
  const [downloadState, setDownloadState] = useState({ status: "idle", progress: 0, error: "" });
  const [groupId, setGroupId] = useState("all");
  const [teamId, setTeamId] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const playerRequestRef = useRef(0);
  const downloadTimerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(downloadTimerRef.current), []);
  useEffect(() => {
    window.clearTimeout(downloadTimerRef.current);
    setDownloadState({ status: "idle", progress: 0, error: "" });
  }, [replayId]);

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

  useEffect(() => {
    publicApi
      .get("/health")
      .then((response) => setHealth(payload(response, {})))
      .catch(() => undefined);
  }, []);

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

  useEffect(() => {
    if (!replayId) {
      detailRequestRef.current += 1;
      playerRequestRef.current += 1;
      setSelected(null);
      setStream(null);
      setDetailError("");
      setPlayerError("");
      setPlayerLoading(false);
      return undefined;
    }

    const id = String(replayId);
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
    // A public summary is optional: a 404 just means the admin has not published one.
    setSummary(null);
    publicApi
      .get(`/replays/${encodeURIComponent(id)}/summary`)
      .then((response) => {
        if (detailRequestId !== detailRequestRef.current) return;
        const body = payload(response, {});
        // Chapters-only mode intentionally has an empty summary; judging by the
        // prose alone would hide it exactly when the admin chose to publish it.
        const hasProse = typeof body?.summary === 'string' && body.summary.trim();
        const hasChapters = Array.isArray(body?.chapters) && body.chapters.length > 0 || Array.isArray(body?.highlights) && body.highlights.length > 0;
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

  const serviceOnline = useMemo(
    () => Boolean(health) && health?.ok !== false && health?.status !== "offline",
    [health]
  );
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

  const requestDownload = useCallback(async () => {
    if (!selected?.replayId || ["preparing", "verifying"].includes(downloadState.status)) return;
    window.clearTimeout(downloadTimerRef.current);
    setDownloadState({ status: "preparing", progress: 0, error: "" });
    try {
      await publicApi.post(`/replays/${encodeURIComponent(selected.replayId)}/download`);
      const poll = async () => {
        try {
          const response = await publicApi.get(`/replays/${encodeURIComponent(selected.replayId)}/download/status`);
          const state = payload(response, {});
          setDownloadState(state);
          if (state.status === "ready") {
            window.location.href = `/api/public/replays/${encodeURIComponent(selected.replayId)}/download`;
          } else if (state.status !== "failed") {
            downloadTimerRef.current = window.setTimeout(poll, 1000);
          }
        } catch (error) {
          setDownloadState({ status: "failed", progress: 0, error: errorMessage(error, t.download.statusError) });
        }
      };
      await poll();
    } catch (error) {
      setDownloadState({ status: "failed", progress: 0, error: errorMessage(error, t.download.unavailable) });
    }
  }, [downloadState.status, selected]);

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
            <span>{serviceOnline ? t.service.online : t.service.checking}</span>
          </div>
        </div>
      </header>

      <main className="public-main">
        <PublicMediaTabs active="replay" />

        {replayId && (
          <section className={`featured-live featured-replay replay-layout-${layout}`}>
            <button className="back-link" onClick={() => navigate("/replays")}>
              <IconArrowLeft size={16} /> 返回重播列表
            </button>
            <div className="replay-layout-toolbar" role="group" aria-label={t.layout.label}>
              <span>{t.layout.label}</span>
              {['portrait', 'landscape'].map((value) => (
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
            <div className="replay-detail-columns">
              <div className="replay-detail-player replay-stage">
                {playerLoading ? (
                  <LoadingState
                    text={t.detail.prep}
                    slowText={t.detail.prepSlow}
                    slowAfterMs={8000}
                    slowHint={t.detail.prepHint}
                    onRetry={() => loadPlay(replayId)}
                  />
                ) : playerError ? (
                  <div className="player-request-error" role="alert">
                    <IconAlertCircle size={32} color="var(--danger)" />
                    <strong>重播暂时无法播放</strong>
                    <span>{playerError}</span>
                    <button className="btn btn-secondary" onClick={() => loadPlay(replayId)}>
                      <IconRefresh size={14} /> 重新获取播放地址
                    </button>
                  </div>
                ) : stream?.proxyUrl ? (
                  <VideoPlayer
                    mode="replay"
                    stream={stream}
                    poster={selected?.cover}
                    title={selected?.title}
                    onRetry={() => loadPlay(replayId)}
                  />
                ) : (
                  <LoadingState text={t.detail.playerPrep} slowText={t.detail.playerPrepSlow} slowAfterMs={8000} />
                )}
              </div>
              <div className="replay-detail-info">
                {selected && (
                  <div className="featured-meta">
                    <div className="featured-heading">
                      <span
                        className={`replay-type-pill ${selected.category.includes("电台") ? "radio" : "video"}`}
                        style={{ position: "static" }}
                      >
                        {selected.category.includes("电台") ? <IconRadio size={13} /> : <IconFilm size={13} />}
                        <span>{selected.category}</span>
                      </span>
                      <h1>{selected.title}</h1>
                    </div>
                    <p>
                      <strong>{selected.memberName}</strong>
                      <span>·</span>
                      <span>{formatReplayTime(selected.startedAt, t)}</span>
                      {selectedDuration && <><span>·</span><span>{selectedDuration}</span></>}
                    </p>
                    <div className="featured-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={requestDownload}
                        disabled={["preparing", "verifying"].includes(downloadState.status)}
                      >
                        <IconDownload size={14} />
                        {downloadLabel(downloadState, t)}
                      </button>
                      <span className="featured-action-note">
                        {downloadState.error || downloadNote(downloadState, t)}
                      </span>
                      {downloadState.status === "ready" && (
                        <a
                          className="btn btn-primary btn-sm"
                          href={`/api/public/replays/${encodeURIComponent(selected.replayId)}/download`}
                          download
                        >
                          <IconDownload size={14} /> 下载文件
                        </a>
                      )}
                    </div>
                    <div className="replay-version-export">
                      <label>
                        <span>{t.export.label}</span>
                        <select
                          aria-label={t.export.label}
                          value={exportVersion}
                          onChange={(event) => setExportVersion(event.target.value)}
                          aria-describedby="replay-version-export-note"
                        >
                          <option value="landscape">{t.export.landscape}</option>
                          <option value="portrait">{t.export.portrait}</option>
                          <option value="audio">{t.export.audio}</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled
                        aria-describedby="replay-version-export-note"
                      >
                        <IconDownload size={14} /> {t.export.action}
                      </button>
                      <p id="replay-version-export-note" className="replay-version-export-note">
                        {t.export.unavailable}
                      </p>
                    </div>
                    {detailError && (
                      <div className="detail-note" role="status">
                        {detailError}，当前显示列表中的信息。
                      </div>
                    )}
                  </div>
                )}
                <div className="public-replay-share">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={copyShareLink}>
                    <IconCopy size={13} />
                    {shareState === "copied" ? t.share.copied : shareState === "failed" ? t.share.failed : t.share.idle}
                  </button>
                </div>
                {summary && <PublicReplaySummary value={summary} t={t} />}
                {!selected && detailError && (
                  <div className="detail-note standalone" role="alert">{detailError}</div>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="public-list-section">
          <div className="public-filter-row">
            <div>
              <span className="eyebrow">MEMBER REPLAYS</span>
              <h2>往期公开重播</h2>
            </div>
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

          <div className="replay-filter-bar" aria-label={t.page.groupFilter}>
            <div className="group-tabs-list">
              <button
                type="button"
                className={`group-tab-btn ${groupId === "all" ? "active" : ""}`}
                onClick={() => handleGroupTabClick("all")}
              >
                全部团体
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
            </div>

            {selectedGroup && selectedGroup.teams.length > 0 && (
              <div className="team-select-shell" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>队伍：</span>
                <select
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="all">全部队伍</option>
                  {selectedGroup.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(filtersActive || searchQuery) && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={resetFilters}
              >
                重置筛选
              </button>
            )}
          </div>

          {searchInfo?.applied && !loading && (
            <p className="search-result-note">
              已显示「{searchInfo.members.map((member) => member.memberName).join("、")}」最近 {replays.length} 场公开重播
            </p>
          )}

          {listError && !loading && (
            <div className="toast-card toast-error" style={{ marginBottom: "20px" }}>
              <div className="toast-message">{listError}</div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => loadReplays({ group: groupId, team: teamId })}
              >
                重新加载
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
                  />
                ))}
              </div>
              <div className="replay-pagination">
                {moreError && (
                  <div className="pagination-error" role="alert">
                    {moreError}
                  </div>
                )}
                {hasMore && (
                  <button
                    className="btn btn-secondary"
                    disabled={loadingMore}
                    onClick={() =>
                      loadReplays({
                        append: true,
                        cursor: next,
                        group: groupId,
                        team: teamId,
                      })
                    }
                  >
                    {loadingMore
                      ? t.page.loading
                      : moreError
                      ? t.page.retryMore
                      : t.page.loadMore}
                  </button>
                )}
                {!hasMore && filteredReplays.length > 0 && (
                  <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    已经到底了
                  </span>
                )}
              </div>
            </>
          ) : !listError ? (
            <EmptyState
              icon={IconFilm}
              title={
                filtersActive || searchQuery
                  ? t.page.empty
                  : t.page.none
              }
              detail={
                filtersActive || searchQuery
                  ? searchInfo && !searchInfo.applied
                    ? `未找到名称为“${searchQuery.trim()}”的成员；也可以按当前已加载的标题筛选。`
                    : t.page.emptyHint
                  : t.page.noneHint
              }
              action={
                filtersActive || searchQuery ? (
                  <button className="btn btn-secondary" onClick={resetFilters}>
                    清除筛选
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary"
                    onClick={() => loadReplays()}
                  >
                    <IconRefresh size={14} /> 刷新重播
                  </button>
                )
              }
            />
          ) : null}
        </section>
      </main>

      <footer className="public-footer">
        <span />
        <span>仅展示口袋48官方成员公开重播</span>
      </footer>
    </div>
  );
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
            <span>{serviceOnline ? t.service.online : t.service.checking}</span>
          </div>
        </div>
      </header>

      <main className="public-main">
        <PublicMediaTabs active="replay" />

        {replayId && (
          <section className="featured-live featured-replay">
            <button className="back-link" onClick={() => navigate("/replays")}>
              <IconArrowLeft size={16} /> 返回重播列表
            </button>
            {playerLoading ? (
              <LoadingState
                text={t.detail.prep}
                slowText={t.detail.prepSlow}
                slowAfterMs={8000}
                slowHint={t.detail.prepHint}
                onRetry={() => loadPlay(replayId)}
              />
            ) : playerError ? (
              <div className="player-request-error" role="alert">
                <IconAlertCircle size={32} color="#ff4757" />
                <strong>重播暂时无法播放</strong>
                <span>{playerError}</span>
                <button
                  className="btn btn-secondary"
                  onClick={() => loadPlay(replayId)}
                >
                  <IconRefresh size={14} /> 重新获取播放地址
                </button>
              </div>
            ) : stream?.proxyUrl ? (
              <VideoPlayer
                mode="replay"
                stream={stream}
                poster={selected?.cover}
                title={selected?.title}
                onRetry={() => loadPlay(replayId)}
              />
            ) : (
              <LoadingState text={t.detail.playerPrep} slowText={t.detail.playerPrepSlow} slowAfterMs={8000} />
            )}

            {selected && (
              <div className="featured-meta">
                <div className="featured-heading">
                  <span
                    className={`replay-type-pill ${
                      selected.category.includes("电台") ? "radio" : "video"
                    }`}
                    style={{ position: "static" }}
                  >
                    {selected.category.includes("电台") ? (
                      <IconRadio size={13} />
                    ) : (
                      <IconFilm size={13} />
                    )}
                    <span>{selected.category}</span>
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
                    className="btn btn-secondary btn-sm"
                    onClick={requestDownload}
                    disabled={["preparing", "verifying"].includes(downloadState.status)}
                  >
                    <IconDownload size={14} />
                    {downloadLabel(downloadState, t)}
                  </button>
                  <span className="featured-action-note">
                    {downloadState.error || downloadNote(downloadState, t)}
                  </span>
                  {downloadState.status === "ready" && (
                    <a
                      className="btn btn-primary btn-sm"
                      href={`/api/public/replays/${encodeURIComponent(selected.replayId)}/download`}
                      download
                    >
                      <IconDownload size={14} /> 下载文件
                    </a>
                  )}
                </div>
                {detailError && (
                  <div className="detail-note" role="status">
                    {detailError}，当前显示列表中的信息。
                  </div>
                )}
              </div>
            )}
            {summary && (
              <PublicReplaySummary value={summary} t={t} />
            )}
            {!selected && detailError && (
              <div className="detail-note standalone" role="alert">
                {detailError}
              </div>
            )}
          </section>
        )}

        <section className="public-list-section">
          <div className="public-filter-row">
            <div>
              <span className="eyebrow">MEMBER REPLAYS</span>
              <h2>往期公开重播</h2>
            </div>
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

          <div className="replay-filter-bar" aria-label={t.page.groupFilter}>
            <div className="group-tabs-list">
              <button
                type="button"
                className={`group-tab-btn ${groupId === "all" ? "active" : ""}`}
                onClick={() => handleGroupTabClick("all")}
              >
                全部团体
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
            </div>

            {selectedGroup && selectedGroup.teams.length > 0 && (
              <div className="team-select-shell" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>队伍：</span>
                <select
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="all">全部队伍</option>
                  {selectedGroup.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(filtersActive || searchQuery) && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={resetFilters}
              >
                重置筛选
              </button>
            )}
          </div>

          {searchInfo?.applied && !loading && (
            <p className="search-result-note">
              已显示「{searchInfo.members.map((member) => member.memberName).join("、")}」最近 {replays.length} 场公开重播
            </p>
          )}

          {listError && !loading && (
            <div className="toast-card toast-error" style={{ marginBottom: "20px" }}>
              <div className="toast-message">{listError}</div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => loadReplays({ group: groupId, team: teamId })}
              >
                重新加载
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
                  />
                ))}
              </div>
              <div className="replay-pagination">
                {moreError && (
                  <div className="pagination-error" role="alert">
                    {moreError}
                  </div>
                )}
                {hasMore && (
                  <button
                    className="btn btn-secondary"
                    disabled={loadingMore}
                    onClick={() =>
                      loadReplays({
                        append: true,
                        cursor: next,
                        group: groupId,
                        team: teamId,
                      })
                    }
                  >
                    {loadingMore
                      ? t.page.loading
                      : moreError
                      ? t.page.retryMore
                      : t.page.loadMore}
                  </button>
                )}
                {!hasMore && filteredReplays.length > 0 && (
                  <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    已经到底了
                  </span>
                )}
              </div>
            </>
          ) : !listError ? (
            <EmptyState
              icon={IconFilm}
              title={
                filtersActive || searchQuery
                  ? t.page.empty
                  : t.page.none
              }
              detail={
                filtersActive || searchQuery
                  ? searchInfo && !searchInfo.applied
                    ? `未找到名称为“${searchQuery.trim()}”的成员；也可以按当前已加载的标题筛选。`
                    : t.page.emptyHint
                  : t.page.noneHint
              }
              action={
                filtersActive || searchQuery ? (
                  <button className="btn btn-secondary" onClick={resetFilters}>
                    清除筛选
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary"
                    onClick={() => loadReplays()}
                  >
                    <IconRefresh size={14} /> 刷新重播
                  </button>
                )
              }
            />
          ) : null}
        </section>
      </main>

      <footer className="public-footer">
        <span />
        <span>仅展示口袋48官方成员公开重播</span>
      </footer>
    </div>
  );
}

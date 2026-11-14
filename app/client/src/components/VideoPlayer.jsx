import { useEffect, useMemo, useRef, useState } from "react";
import DanmakuOverlay from "./DanmakuOverlay";
import ReplayDanmakuOverlay from "./ReplayDanmakuOverlay";
import { chooseHlsPlaybackEngine, safeHlsErrorFacts } from "../lib/playback";

// hls.js (~579KB) and flv.js (~152KB) are loaded on demand rather than imported
// statically. This component is reachable from every page that can show a video,
// and those probes pull it into the initial bundle of pages that never play
// anything: the public landing page is a list, yet it was downloading 731KB of
// player code it could not use. Deferring the imports keeps the libraries out of
// the first paint and costs one extra request only when a stream actually starts.
let hlsPromise = null;
let flvPromise = null;

// The two packages need different unwrapping, and Vite decides which by inspecting
// each package's module shape at build time. Confirmed from the emitted chunk:
//
//   hls.js -> import("./hls-*.js")              namespace; library is on `default`
//   flv.js -> import("./flv-*.js").then(e=>e.f) Vite already unwraps the CJS export
//
// So an explicit `.default` is required for hls.js and must be omitted for flv.js:
// adding `.default` to flv.js would defeat the unwrap Vite injected and yield
// undefined, which is exactly the failure this replaced. Written per-library rather
// than through a shared helper, because the correct unwrap is a property of each
// package, not something to be sniffed at runtime.
function loadHls() {
  if (!hlsPromise) hlsPromise = import("hls.js").then(module => module.default);
  return hlsPromise;
}

function loadFlv() {
  if (!flvPromise) flvPromise = import("flv.js");
  return flvPromise;
}

function streamType(stream) {
  const protocol = String(stream?.protocol || stream?.type || "").toLowerCase();
  return ["hls", "flv", "mp4"].includes(protocol) ? protocol : null;
}

export default function VideoPlayer({ stream, poster, title, onRetry, onFallback, onLoadedMetadata, onTimeUpdate, startAt = 0, mode = "live" }) {
  const videoRef = useRef(null);
  const [stage, setStage] = useState(null);
  const playerRef = useRef(null);
  const fallbackRef = useRef(onFallback);
  const [error, setError] = useState("");
  const url = useMemo(() => stream?.proxyUrl || stream?.playUrl || "", [stream]);
  const isLive = mode !== "replay";

  useEffect(() => { fallbackRef.current = onFallback; }, [onFallback]);

  useEffect(() => {
    const video = videoRef.current;
    let disposed = false;
    let retryTimer = null;
    let fallbackStarted = false;
    let removePlayerListeners = () => {};
    setError("");
    if (!video || !url) return undefined;

    // One-shot resume: callers pass `startAt` only when remounting after a
    // fetch retry, and the position jumps once on the first metadata load.
    // Deliberately not in the effect deps — a prop change afterwards must not
    // reload the stream, it only means "stop seeking".
    let seekPending = Number(startAt) > 0;
    const handleSeekMetadata = () => {
      if (!seekPending) return;
      seekPending = false;
      try { video.currentTime = Number(startAt); } catch {}
    };
    video.addEventListener("loadedmetadata", handleSeekMetadata);

    const showError = message => { if (!disposed) setError(message); };
    const tryFallback = () => {
      if (fallbackStarted || typeof fallbackRef.current !== "function") return false;
      fallbackStarted = true;
      setError("");
      fallbackRef.current();
      return true;
    };
    const destroy = () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      removePlayerListeners();
      video.removeEventListener("loadedmetadata", handleSeekMetadata);
      try { playerRef.current?.destroy?.(); } catch {}
      playerRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
    const play = () => { if (isLive) video.play().catch(() => undefined); };
    const type = streamType(stream);
    const mediaLabel = isLive ? "直播流" : "重播";

    if (!type) {
      showError("播放协议无效，请重新获取播放地址。");
      return destroy;
    }

    // MP4 needs no third-party player, so it stays fully synchronous.
    if (type === "mp4") {
      const handleMp4Error = () => showError(`MP4 ${mediaLabel}加载失败，请稍后重试。`);
      video.addEventListener("error", handleMp4Error);
      video.src = url;
      video.load();
      play();
      removePlayerListeners = () => video.removeEventListener("error", handleMp4Error);
      return destroy;
    }

    // FLV and HLS await their library. `disposed` is re-checked after every await
    // because the effect may be torn down while the chunk is still in flight; a
    // late player would otherwise attach to a detached element.
    const startFlv = async () => {
      const flvjs = await loadFlv();
      if (disposed) return;
      if (!flvjs.isSupported()) {
        showError("当前浏览器不支持 FLV 播放，请换用最新版 Chrome 或 Edge。");
        return;
      }
      const player = flvjs.createPlayer({ type: "flv", url, isLive }, isLive ? {
        enableStashBuffer: false,
        stashInitialSize: 128,
      } : {
        enableStashBuffer: true,
      });
      const handleFlvError = () => {
        if (!tryFallback()) showError(`FLV ${mediaLabel}连接失败，请重新获取播放地址。`);
      };
      playerRef.current = player;
      player.on(flvjs.Events.ERROR, handleFlvError);
      removePlayerListeners = () => {
        try { player.off(flvjs.Events.ERROR, handleFlvError); } catch {}
      };
      player.attachMediaElement(video);
      player.load();
      play();
    };

    const startHls = async () => {
      const Hls = await loadHls();
      if (disposed) return;
      const hlsEngine = chooseHlsPlaybackEngine({
        hlsJsSupported: Hls.isSupported(),
        nativeHlsSupported: Boolean(video.canPlayType("application/vnd.apple.mpegurl")),
      });

      if (hlsEngine === "hls.js") {
        const hls = new Hls(isLive ? {
          lowLatencyMode: true,
          liveSyncDurationCount: 3,
          backBufferLength: 30,
        } : {
          lowLatencyMode: false,
          backBufferLength: 90,
        });
        let networkRetries = 0;
        let mediaRetries = 0;
        playerRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          const facts = safeHlsErrorFacts(data);
          console.warn("[VideoPlayer] HLS playback event", { mode, ...facts });
          if (!data.fatal || disposed) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
            networkRetries += 1;
            retryTimer = window.setTimeout(() => { if (!disposed) hls.startLoad(); }, 800 * networkRetries);
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 1) {
            mediaRetries += 1;
            hls.recoverMediaError();
            return;
          }
          const diagnostic = [facts.details, facts.status ? `HTTP ${facts.status}` : null, facts.contentType].filter(Boolean).join(" · ");
          if (!tryFallback()) showError(`HLS ${mediaLabel}连接失败${diagnostic ? `（${diagnostic}）` : ""}，请重新获取播放地址。`);
          hls.stopLoad();
        });
      } else if (hlsEngine === "native") {
        const handleNativeError = () => {
          if (!tryFallback()) showError(`HLS ${mediaLabel}加载失败，请重新获取播放地址。`);
        };
        const handleLoadedMetadata = () => play();
        video.addEventListener("error", handleNativeError);
        video.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
        removePlayerListeners = () => {
          video.removeEventListener("error", handleNativeError);
          video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        };
        video.src = url;
      } else {
        showError("当前浏览器不支持 HLS 播放。");
      }
    };

    const start = type === "flv" ? startFlv : startHls;
    start().catch(() => {
      // A failed chunk fetch is a load failure like any other, and the caller may
      // still have a working fallback stream.
      if (!disposed && !tryFallback()) showError("播放器加载失败，请重新获取播放地址。");
    });

    return destroy;
  }, [stream, url, isLive, mode]);

  return (
    <div className={`video-shell ${stream?.liveId ? "replay-player-shell" : ""}`}>
      <div className="video-stage" ref={setStage}>
        <video
          ref={videoRef}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          className="video-player"
          controls
          playsInline
          autoPlay={isLive}
          poster={poster || undefined}
          aria-label={`${title || (isLive ? "直播" : "重播")}播放器`}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -5 : 5;
              videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime + delta);
            } else if (event.key === "j" || event.key === "J") {
              videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10);
            } else if (event.key === "l" || event.key === "L") {
              videoRef.current.currentTime += 10;
            }
          }}
        />

        {error && (
          <div className="player-error" role="alert">
            <span>{error}</span>
            {onRetry && <button className="btn btn-secondary btn-sm" onClick={onRetry}>重新获取</button>}
          </div>
        )}
      </div>
      {isLive && <DanmakuOverlay key={stream?.liveId} liveId={stream?.liveId} stage={stage} />}
      {!isLive && <ReplayDanmakuOverlay replayId={stream?.liveId} videoRef={videoRef} available={stream?.danmakuAvailable} />}
    </div>
  );
}

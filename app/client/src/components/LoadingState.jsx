import React, { useEffect, useState } from "react";

// The two strings this component owns follow the browser language. Callers keep
// passing their own copy, so a page can still be fully translated elsewhere.
export const LOADING_TEXT = {
  zh: { waited: (seconds) => `已等待 ${seconds} 秒`, reload: "重新加载" },
  en: { waited: (seconds) => `Waiting ${seconds}s`, reload: "Reload" },
};
export function languageOf(languages) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return typeof first === "string" && /^en\b/i.test(first) ? "en" : "zh";
}

// A spinner with no elapsed time is indistinguishable from a frozen page: the
// public live list polls every 30s and a slow Pocket48 round trip can hold this
// component on screen long enough that visitors assume the page is stuck. After
// a few seconds the state admits how long it has been waiting and, unless the
// caller handles errors itself, gives the visitor something to do about it.
function LoadingState({
  text = "正在加载…",
  slowText = "",
  slowAfterMs = 5000,
  slowHint = "",
  onRetry,
  languages,
}) {
  const copy = LOADING_TEXT[
    languageOf(languages ?? (typeof navigator === "undefined" ? "zh" : navigator.languages || navigator.language))
  ];
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!slowText) return undefined;
    // Fake timers in the test environment stay real unless a suite asks
    // otherwise; guard so an unconfigured timer API can never blank the text.
    if (typeof window === "undefined") return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - started);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [slowText]);

  const slow = Boolean(slowText) && elapsed >= slowAfterMs;

  return (
    <div className={`state-card${slow ? " state-card-slow" : ""}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {slow ? (
        <span className="state-card-slow-copy">
          <span className="state-card-slow-line">
            {slowText}
            <span className="state-card-elapsed">{
              copy.waited(Math.round(elapsed / 1000))
            }</span>
          </span>
          {(slowHint || onRetry) && (
            <span className="state-card-slow-actions">
              {slowHint && <span className="state-card-hint">{slowHint}</span>}
              {onRetry && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                  {copy.reload}
                </button>
              )}
            </span>
          )}
        </span>
      ) : (
        <span>{text}</span>
      )}
    </div>
  );
}

export default LoadingState;

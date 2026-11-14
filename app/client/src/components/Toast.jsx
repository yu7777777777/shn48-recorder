import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconInfo, IconX } from "./Icons";

const MAX_VISIBLE = 3;
// A failing upstream is usually reported by several requests in the same burst.
// Collapse repeated identical errors into one card with a repeat count instead of
// stacking one card per failure.
const DEDUPE_MS = 60_000;

// On a dedupe hit, look up the card the recorded key still points at. A found
// card gets refreshed (repeat count + timer reset); undefined means the card is
// already gone (auto-dismissed, closed, or evicted) and a fresh one must be
// restacked so a persistent failure stays visible.
function findDedupeTarget(toastList, lastError) {
  if (!lastError || !lastError.id) return undefined;
  return toastList.find((t) => t.id === lastError.id);
}

const ToastContext = createContext({
  showToast: () => {},
  success: () => {},
  error: () => {},
  warning: () => {},
  info: () => {},
});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Mirror of the toast list so showToast can inspect live cards synchronously
  // without depending on the list, which would break context value stability.
  const toastsRef = useRef([]);
  // Pending auto-remove timers by id, so a dedupe refresh can reset one and a
  // manual close cancels it instead of leaving it behind.
  const timers = useRef(new Map());
  const lastErrorKey = useRef({ message: null, at: 0 });

  const commit = useCallback((next) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const removeToast = useCallback(
    (id) => {
      const pending = timers.current.get(id);
      if (pending) {
        clearTimeout(pending);
        timers.current.delete(id);
      }
      commit(toastsRef.current.filter((t) => t.id !== id));
    },
    [commit]
  );

  const scheduleRemoval = useCallback(
    (id, delay) => {
      if (!(delay > 0)) return;
      const pending = timers.current.get(id);
      if (pending) clearTimeout(pending);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          removeToast(id);
        }, delay)
      );
    },
    [removeToast]
  );

  const pushToast = useCallback(
    (toast) => {
      // Keep the newest cards; an old card leaving early must not jump around.
      // A card evicted here keeps its timer until it fires into an empty filter
      // and cleans itself up.
      commit([...toastsRef.current, toast].slice(-MAX_VISIBLE));
      scheduleRemoval(toast.id, toast.duration);
      return toast.id;
    },
    [commit, scheduleRemoval]
  );

  const showToast = useCallback(
    (message, type = "info", duration = 3500) => {
      const text = String(message ?? "");
      const now = Date.now();
      const last = lastErrorKey.current;
      if (type === "error" && text && last.message === text && now - last.at < DEDUPE_MS) {
        const repeats = (last.repeats || 1) + 1;
        const live = findDedupeTarget(toastsRef.current, last);
        if (live) {
          // Bump the count and reset auto-dismiss so an actively repeating
          // error stays on screen.
          commit(
            toastsRef.current.map((t) =>
              t.id === live.id ? { ...t, repeats: (t.repeats || 1) + 1, at: now } : t
            )
          );
          scheduleRemoval(live.id, live.duration);
          lastErrorKey.current = { message: text, at: now, repeats, id: live.id, duration: live.duration };
          return null;
        }
        // The previous card is already gone; restack a fresh one with the
        // recorded repeat count instead of staying silent.
        const id = Date.now() + Math.random().toString(36).slice(2, 7);
        lastErrorKey.current = { message: text, at: now, repeats, id, duration };
        return pushToast({ id, message: text, type: "error", duration, repeats, at: now });
      }
      const id = Date.now() + Math.random().toString(36).slice(2, 7);
      if (type === "error") {
        lastErrorKey.current = { message: text, at: now, repeats: 1, id, duration };
      }
      return pushToast({ id, message: text, type, duration, repeats: 1, at: now });
    },
    [commit, pushToast, scheduleRemoval]
  );

  const success = useCallback((msg, duration) => showToast(msg, "success", duration), [showToast]);
  const error = useCallback((msg, duration) => showToast(msg, "error", duration || 4500), [showToast]);
  const warning = useCallback((msg, duration) => showToast(msg, "warning", duration), [showToast]);
  const info = useCallback((msg, duration) => showToast(msg, "info", duration), [showToast]);

  // Stable identity across toast churn: consumers must not re-render (and, via
  // effects keyed on the context value, refetch) when a toast appears or leaves.
  const contextValue = useMemo(
    () => ({ showToast, success, error, warning, info }),
    [showToast, success, error, warning, info]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="toast-container" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast-card toast-${item.type}`} role="status">
            <div className="toast-icon">
              {item.type === "success" && <IconCheck size={16} />}
              {item.type === "error" && <IconAlertCircle size={16} />}
              {item.type === "warning" && <IconAlertTriangle size={16} />}
              {item.type === "info" && <IconInfo size={16} />}
            </div>
            <div className="toast-message">
              {item.message}
              {item.repeats > 1 && <span className="toast-repeat">（已重复 {item.repeats} 次）</span>}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => removeToast(item.id)}
              aria-label="关闭通知"
            >
              <IconX size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

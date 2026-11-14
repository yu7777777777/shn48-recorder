import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconInfo, IconX } from "./Icons";

const MAX_VISIBLE = 3;
// A failing upstream is usually reported by several requests in the same burst.
// Collapse repeated identical errors into one card with a repeat count instead of
// stacking one card per failure.
const DEDUPE_MS = 60_000;

const ToastContext = createContext({
  showToast: () => {},
  success: () => {},
  error: () => {},
  warning: () => {},
  info: () => {},
});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const lastErrorKey = useRef({ message: null, at: 0 });

  const removeToast = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message, type = "info", duration = 3500) => {
      const text = String(message ?? "");
      if (type === "error") {
        const now = Date.now();
        if (text && lastErrorKey.current.message === text && now - lastErrorKey.current.at < DEDUPE_MS) {
          lastErrorKey.current = { message: text, at: now };
          setToasts((current) =>
            current.map((t) =>
              t.type === "error" && t.message === text ? { ...t, repeats: (t.repeats || 1) + 1, at: now } : t
            )
          );
          return null;
        }
        lastErrorKey.current = { message: text, at: now };
      }
      const id = Date.now() + Math.random().toString(36).slice(2, 7);
      const toast = { id, message: text, type, duration, repeats: 1, at: Date.now() };
      // Keep the newest cards; an old card leaving early must not jump around.
      setToasts((current) => [...current, toast].slice(-MAX_VISIBLE));

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
      return id;
    },
    [removeToast]
  );

  const success = useCallback((msg, duration) => showToast(msg, "success", duration), [showToast]);
  const error = useCallback((msg, duration) => showToast(msg, "error", duration || 4500), [showToast]);
  const warning = useCallback((msg, duration) => showToast(msg, "warning", duration), [showToast]);
  const info = useCallback((msg, duration) => showToast(msg, "info", duration), [showToast]);

  return (
    <ToastContext.Provider value={{ showToast, success, error, warning, info }}>
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

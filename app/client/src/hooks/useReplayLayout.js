import { useCallback, useEffect, useRef, useState } from "react";

// Which arrangement the replay page draws for itself: a stacked "portrait"
// column or the two-column "landscape" stage. The choice belongs to the
// visitor, not to the page, so it survives a reload and every route change.
//
// Storage is a nice-to-have: private browsing and some embedded webviews throw
// on every localStorage access, and a thrown getter here would take the whole
// page down before the first paint. Every read and write is therefore guarded
// and silently falls back to the in-memory value.
export const REPLAY_LAYOUT_STORAGE_KEY = "snh48.replay.layout";
export const REPLAY_LAYOUTS = ["portrait", "landscape"];
export const DEFAULT_REPLAY_LAYOUT = "portrait";

export function normalizeReplayLayout(value) {
  return REPLAY_LAYOUTS.includes(value) ? value : DEFAULT_REPLAY_LAYOUT;
}

function readStoredLayout() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return DEFAULT_REPLAY_LAYOUT;
    return normalizeReplayLayout(window.localStorage.getItem(REPLAY_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_REPLAY_LAYOUT;
  }
}

function writeStoredLayout(layout) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(REPLAY_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Storage is full or blocked; the session keeps working with state only.
  }
}

export default function useReplayLayout() {
  // Lazy initialiser: the stored choice is read once on mount, never on every
  // render, and never during a server-side render where window is absent.
  const [layout, setLayoutState] = useState(readStoredLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Updater functions (e.g. `setLayout((current) => ...)`) read the value held
  // in state, never storage: a stale stored value would otherwise make the
  // updater compute from something the visitor is not looking at.
  const setLayout = useCallback((next) => {
    const value = typeof next === "function" ? next(layoutRef.current) : next;
    const normalized = normalizeReplayLayout(value);
    writeStoredLayout(normalized);
    setLayoutState(normalized);
  }, []);

  // Another tab flipping the switch should move this one too; when one tab
  // clears the key the others fall back to the default instead of keeping a
  // choice nobody remembers making.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onStorage = (event) => {
      if (event.key !== null && event.key !== REPLAY_LAYOUT_STORAGE_KEY) return;
      setLayoutState(normalizeReplayLayout(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => {
    setLayout((current) => (current === "landscape" ? "portrait" : "landscape"));
  }, [setLayout]);

  return { layout, setLayout, toggle };
}

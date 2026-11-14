import { useEffect, useRef } from "react";

// Shared polling loop for admin pages.
//
// Behaviour that every page previously hand-rolled (and got subtly wrong):
//   * the latest callback is always used without re-subscribing the timer;
//   * a hidden tab stops issuing requests and refreshes once when it returns;
//   * failures back off exponentially instead of hammering a broken backend;
//   * the loop never overlaps itself and always clears on unmount.
// `resetKeys` mirrors the dependency array of the effect the loop replaces:
// when any key changes the timer is torn down, the callback re-runs
// immediately and polling resumes with the new values.
export default function usePolling(callback, intervalMs = 10000, resetKeys = []) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let running = false;

    const clear = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delay) => {
      clear();
      if (!cancelled && !document.hidden) timer = window.setTimeout(tick, delay);
    };

    async function tick() {
      if (cancelled) return;
      if (document.hidden) {
        schedule(intervalRef.current);
        return;
      }
      if (running) return;
      running = true;
      let ok = true;
      try {
        await callbackRef.current();
      } catch {
        ok = false;
      } finally {
        running = false;
      }
      if (cancelled) return;
      // Switch tabs mid-flight: defer to the visibility handler rather than
      // queueing another request from a page nobody is looking at.
      if (document.hidden) return;
      const base = intervalRef.current;
      schedule(ok ? base : Math.min(base * 2, 60000));
    }

    const onVisible = () => {
      if (document.hidden) {
        clear();
        return;
      }
      void tick();
    };

    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, resetKeys);
}

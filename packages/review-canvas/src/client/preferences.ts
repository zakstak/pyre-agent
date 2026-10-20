import { useEffect, useState, type RefObject } from "react";

/** URL values win over browser preferences, so links remain shareable. Storage is optional. */
export const usePreference = (
  key: string,
  fallback: string,
  namespace = location.pathname,
) => {
  const storageKey = `review-canvas:${namespace}:${key}`;
  const [value, setValue] = useState(() => {
    const url = new URL(location.href).searchParams.get(key);
    if (url !== null) return url;
    try {
      return localStorage.getItem(storageKey) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const write = (next: string) => {
    setValue(next);
    const url = new URL(location.href);
    url.searchParams.set(key, next);
    history.replaceState(history.state, "", url);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* Browser storage may be disabled. */
    }
  };
  return [value, write] as const;
};

/** A single visible page refreshes on focus and once a minute, without overlapping requests. */
export const useFreshness = (refresh: () => void, waiting: boolean) => {
  useEffect(() => {
    const update = () => {
      if (!waiting && document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh, waiting]);
};

/** Reading positions belong to this browser tab and this exact collected revision. */
export const useReadingPosition = (
  key: string,
  element?: RefObject<HTMLElement | null>,
) => {
  useEffect(() => {
    const node = element?.current;
    if (element !== undefined && node == null) return;
    const target = node ?? window;
    const frame = requestAnimationFrame(() => {
      try {
        const saved = Number(sessionStorage.getItem(key) ?? 0);
        if (Number.isFinite(saved)) {
          if (node) node.scrollTop = saved;
          else window.scrollTo(0, saved);
        }
      } catch {
        /* Optional storage. */
      }
    });
    const save = () => {
      try {
        sessionStorage.setItem(key, String(node?.scrollTop ?? window.scrollY));
      } catch {
        /* Optional storage. */
      }
    };
    target.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", save);
    };
  }, [key, element]);
};

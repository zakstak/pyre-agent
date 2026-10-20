import { useEffect, useState } from "react";

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
export const useReadingPosition = (key: string) => {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        window.scrollTo(0, Number(sessionStorage.getItem(key) ?? 0));
      } catch {
        /* Optional storage. */
      }
    });
    const save = () => {
      try {
        sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        /* Optional storage. */
      }
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", save);
    };
  }, [key]);
};

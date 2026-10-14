/** Media queries as React state: a component reads whether one matches and redraws when that changes. */
import { useCallback, useMemo, useSyncExternalStore } from "react";

export const useMedia = (query: string): boolean => {
  const media = useMemo(() => matchMedia(query), [query]);
  const subscribe = useCallback(
    (change: () => void) => {
      media.addEventListener("change", change);
      return () => media.removeEventListener("change", change);
    },
    [media],
  );
  return useSyncExternalStore(subscribe, () => media.matches);
};

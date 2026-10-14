/**
 * The theme, chosen in the footer: the system's, light, or dark. The choice is kept in local storage; the document's
 * data-theme attribute is what the tokens read.
 */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "./cn.ts";

const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const storage = Atom.runtime(KeyValueStore.layerStorage(() => localStorage));

export const themeAtom = Atom.kvs({
  runtime: storage,
  key: "review-canvas-theme",
  schema: Schema.Literals(THEMES),
  defaultValue: (): Theme => "system",
});

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const subscribe = (change: () => void) => {
  systemDark.addEventListener("change", change);
  return () => systemDark.removeEventListener("change", change);
};

/** Applies the chosen theme to the document while the page is open. */
export const useDocumentTheme = () => {
  const theme = useAtomValue(themeAtom);
  const dark = useSyncExternalStore(subscribe, () => systemDark.matches);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === "system" ? (dark ? "dark" : "light") : theme;
  }, [theme, dark]);
};

export const ThemeControl = () => {
  const [theme, setTheme] = useAtom(themeAtom);
  return (
    <span role="group" aria-label="Theme" className="inline-flex items-center gap-1 text-small text-muted">
      Theme:
      {THEMES.map((choice, at) => (
        <span key={choice} className="inline-flex items-center gap-1">
          {at === 0 ? null : <span aria-hidden="true">·</span>}
          <button
            type="button"
            aria-pressed={theme === choice}
            onClick={() => setTheme(choice)}
            className={cn(
              "cursor-pointer px-1 underline-offset-3",
              theme === choice ? "font-semibold text-ink" : "underline hover:text-ink",
            )}
          >
            {choice}
          </button>
        </span>
      ))}
    </span>
  );
};

/**
 * The theme, chosen in the footer: the system's, light, or dark. The choice is kept in local storage; the document's
 * data-theme attribute is what the tokens read.
 */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { TOUCH_TARGET } from "./button.tsx";
import { cn } from "./cn.ts";
import { useMedia } from "./media.ts";

const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The key and values the shared style's theme.js reads, so the choice is applied before the app renders and is the
 * same choice every page of this origin made: "light" or "dark", and no entry for the system's.
 */
const THEME_KEY = "internal-visual-style-theme";

const savedTheme = (): Theme => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
};

const themeAtom = Atom.writable(savedTheme, (context, theme: Theme) => {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Without storage the choice holds for this page.
  }
  context.setSelf(theme);
}).pipe(Atom.keepAlive);

/** Applies the chosen theme to the document while the page is open. */
export const useDocumentTheme = () => {
  const theme = useAtomValue(themeAtom);
  const dark = useMedia("(prefers-color-scheme: dark)");
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
              TOUCH_TARGET,
              "px-1 underline-offset-3",
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

/**
 * How the pages look, chosen in the appearance settings: the mode, which is the system's, light, or dark, and the
 * palette. Both are kept in local storage under the keys the shared style's theme.js reads, so a page is drawn in
 * them before the app renders and every page of this origin agrees. The document's data-theme and data-palette
 * attributes are what the tokens read.
 */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { cn } from "./cn.ts";
import { useMedia } from "./media.ts";
import { Segmented } from "./segmented.tsx";
import { Setting } from "./setting.tsx";
import { Specimen } from "./specimen.tsx";

const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

/** The palettes tokens.css draws, by the name it knows them by. The first is the default. */
export const PALETTES = [
  ["lifted", "Lifted"],
  ["violet", "Violet"],
  ["charcoal", "Charcoal"],
  ["slate", "Slate"],
  ["ocean", "Ocean"],
  ["forest", "Forest"],
  ["sand", "Sand"],
  ["ember", "Ember"],
  ["rose", "Rose"],
  ["mono", "Mono"],
] as const;
export type Palette = (typeof PALETTES)[number][0];

const isPalette = (name: string): name is Palette => PALETTES.some(([known]) => known === name);
const labelOf = (name: Palette): string => PALETTES.find(([known]) => known === name)?.[1] ?? name;

/** The mode is "light" or "dark", and no entry for the system's; the palette is its name, and no entry for the default. */
const MODE_KEY = "internal-visual-style-theme";
const PALETTE_KEY = "internal-visual-style-palette";

/** A choice kept in local storage, where `absent` is what no entry means; without storage the choice holds for this page. */
const stored = <A extends string>(key: string, absent: A, read: (saved: string) => A | undefined) =>
  Atom.writable(
    (): A => {
      try {
        const saved = localStorage.getItem(key);
        return saved === null ? absent : (read(saved) ?? absent);
      } catch {
        return absent;
      }
    },
    (context, choice: A) => {
      try {
        if (choice === absent) localStorage.removeItem(key);
        else localStorage.setItem(key, choice);
      } catch {
        // Without storage the choice holds for this page.
      }
      context.setSelf(choice);
    },
  ).pipe(Atom.keepAlive);

const modeAtom = stored<Mode>(MODE_KEY, "system", (saved) => (saved === "light" || saved === "dark" ? saved : undefined));
const paletteAtom = stored<Palette>(PALETTE_KEY, "lifted", (saved) => (isPalette(saved) ? saved : undefined));

/** Applies the chosen mode and palette to the document while the page is open. */
export const useDocumentTheme = () => {
  const mode = useAtomValue(modeAtom);
  const palette = useAtomValue(paletteAtom);
  const dark = useMedia("(prefers-color-scheme: dark)");
  useEffect(() => {
    document.documentElement.dataset.theme = mode === "system" ? (dark ? "dark" : "light") : mode;
    document.documentElement.dataset.palette = palette;
  }, [mode, palette, dark]);
};

/**
 * A palette's page with a card on it, the accent and the action, and the two diff tints, in one mode. The half carries
 * the palette itself: the roles resolve their mode where the palette is set, so a forced mode has to be set there too.
 */
const Half = ({ name, scheme }: { readonly name: Palette; readonly scheme: "light" | "dark" }) => (
  <span data-palette={name} className={cn("flex flex-col bg-page p-1.5", scheme === "light" ? "[color-scheme:light]" : "[color-scheme:dark]")}>
    <span className="flex flex-col gap-1 rounded-control bg-surface p-1.5">
      <span className="flex items-center gap-1">
        <span className="size-2.5 rounded-full bg-accent" />
        <span className="size-2.5 rounded-full bg-action" />
        <span className="ml-auto h-1 w-5 rounded-full bg-muted" />
      </span>
      <span className="h-1 w-full rounded-full bg-diff-addition" />
      <span className="h-1 w-2/3 rounded-full bg-diff-deletion" />
    </span>
  </span>
);

/** A palette as a swatch: its light side and its dark side, each drawn in the palette with its mode forced, whatever mode the page is in. */
const Swatch = ({
  name,
  pressed,
  onPress,
  onHover,
}: {
  readonly name: Palette;
  readonly pressed: boolean;
  readonly onPress: () => void;
  readonly onHover: (name: Palette | undefined) => void;
}) => (
  <button
    type="button"
    data-palette-choice={name}
    aria-pressed={pressed}
    onClick={onPress}
    onMouseEnter={() => onHover(name)}
    onFocus={() => onHover(name)}
    onMouseLeave={() => onHover(undefined)}
    onBlur={() => onHover(undefined)}
    className={cn(
      "overflow-hidden rounded-panel border text-left text-small",
      pressed ? "border-accent ring-1 ring-accent" : "border-line hover:border-muted",
    )}
  >
    <span aria-hidden="true" className="grid grid-cols-2">
      <Half name={name} scheme="light" />
      <Half name={name} scheme="dark" />
    </span>
    <span className="block bg-raised px-2 py-1.5 font-medium text-ink">{labelOf(name)}</span>
  </button>
);

/** The appearance settings: the mode, the palettes as swatches, and a sample of the review page in the palette. */
export const Appearance = () => {
  const [mode, setMode] = useAtom(modeAtom);
  const [palette, setPalette] = useAtom(paletteAtom);
  // The swatch under the pointer, or with focus, shows in the sample before it is chosen.
  const [hovered, setHovered] = useState<Palette | undefined>(undefined);
  const shown = hovered ?? palette;
  return (
    <div className="flex flex-col gap-8">
      <Setting id="mode" title="Mode" blurb="Light or dark, or whichever the system says.">
        <Segmented
          label="Mode"
          attribute="data-mode"
          choices={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          value={mode}
          onChange={setMode}
        />
      </Setting>
      <Setting id="palette" title="Palette" blurb="Every palette has a light side and a dark side. Point at one to try it in the sample below.">
        <div role="group" aria-label="Palette" className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
          {PALETTES.map(([name]) => (
            <Swatch key={name} name={name} pressed={palette === name} onPress={() => setPalette(name)} onHover={setHovered} />
          ))}
        </div>
      </Setting>
      <Setting id="preview" title="Preview" blurb={`${labelOf(shown)}, light and dark.`}>
        <div data-preview={shown} className="grid gap-3 lg:grid-cols-2">
          <Specimen data-palette={shown} data-scheme="light" className="[color-scheme:light]" />
          <Specimen data-palette={shown} data-scheme="dark" className="[color-scheme:dark]" />
        </div>
      </Setting>
    </div>
  );
};

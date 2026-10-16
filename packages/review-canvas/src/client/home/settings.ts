/**
 * The settings, as sections of one page, each a path under /settings with the things a reviewer can set. The
 * navigation lists the sections and searches the things, by title and by the words a reviewer might look for.
 */

export interface SettingItem {
  /** The ID of the element on the section's page that the thing is set in. */
  readonly id: string;
  readonly title: string;
  /** Words the search finds it by, besides its title. */
  readonly keywords: string;
}

export interface Section {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<SettingItem>;
}

export const SECTIONS = [
  {
    id: "appearance",
    title: "Appearance",
    items: [
      { id: "mode", title: "Mode", keywords: "light dark system theme" },
      {
        id: "palette",
        title: "Palette",
        keywords:
          "theme colours colors lifted violet charcoal slate ocean forest sand ember rose mono",
      },
      {
        id: "preview",
        title: "Preview",
        keywords: "sample diff thread light dark",
      },
    ],
  },
  {
    id: "repositories",
    title: "Repositories",
    items: [
      {
        id: "monitored",
        title: "Monitored repositories",
        keywords: "checkouts branch remove worktree",
      },
      {
        id: "found",
        title: "Add repository",
        keywords: "monitor discovered accept found",
      },
      {
        id: "scan",
        title: "Scan directories",
        keywords: "rescan directory path roots",
      },
    ],
  },
] as const satisfies ReadonlyArray<Section>;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const isSectionId = (id: string): id is SectionId =>
  SECTIONS.some((section) => section.id === id);

export const sectionOf = (id: SectionId): Section =>
  SECTIONS.find((section) => section.id === id) ?? SECTIONS[0];

/** The path of a section, or of one thing in it. */
export const settingsPath = (section: SectionId, item?: string): string =>
  `/settings/${section}${item === undefined ? "" : `#${item}`}`;

/** The things whose title, words, or section the text is in, with their sections, in the sections' order. */
export const searchSettings = (
  text: string,
): ReadonlyArray<{
  readonly section: (typeof SECTIONS)[number];
  readonly item: SettingItem;
}> => {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [];
  return SECTIONS.flatMap((section) =>
    section.items
      .filter((item) =>
        `${item.title} ${item.keywords} ${section.title}`
          .toLowerCase()
          .includes(needle),
      )
      .map((item) => ({ section, item })),
  );
};

/**
 * The settings navigation: a search over every setting, and under it the sections, or, while searching, the settings
 * found with the section each is in. A wide page keeps it beside the section; a narrower one puts it above.
 */
import { useState } from "react";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import {
  searchSettings,
  type SectionId,
  SECTIONS,
  settingsPath,
} from "./settings.ts";

const ROW =
  "flex min-h-8 items-center rounded-control px-2 text-small no-underline hover:bg-subtle";

export const SettingsNav = ({ current }: { readonly current: SectionId }) => {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const hits = searchSettings(query);
  return (
    <nav
      aria-label="Settings"
      className="min-w-0 md:sticky md:top-14 md:self-start"
    >
      <label className="block">
        <span className="sr-only">Search settings</span>
        <input
          type="search"
          data-settings-search
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          className={FIELD}
        />
      </label>
      {!searching ? (
        <ul className="mt-3 flex flex-col gap-0.5 max-md:flex-row max-md:flex-wrap">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={settingsPath(section.id)}
                data-settings-section={section.id}
                aria-current={section.id === current ? "page" : undefined}
                className={cn(
                  ROW,
                  "text-ink aria-[current]:bg-selected aria-[current]:font-semibold",
                )}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      ) : hits.length === 0 ? (
        <p className="mt-3 px-2 text-small text-muted" role="status">
          Nothing matches.
        </p>
      ) : (
        <ul
          data-settings-results
          className="mt-3 flex flex-col gap-0.5"
          aria-label="Settings found"
        >
          {hits.map(({ section, item }) => (
            <li key={`${section.id}/${item.id}`}>
              <a
                href={settingsPath(section.id, item.id)}
                className={cn(ROW, "flex-col items-start justify-center py-1")}
              >
                <span className="font-medium text-ink">{item.title}</span>
                <span className="text-technical text-muted">
                  {section.title}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
};

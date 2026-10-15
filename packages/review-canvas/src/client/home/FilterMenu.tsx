/**
 * A filter menu under the reviews, as on GitHub's pull request list: the values of one key, each a row that includes
 * it and a button that excludes it. The menu reads its state from the query and writes the query back, so the field,
 * the chips, and the menus never disagree.
 */
import { Popover } from "@base-ui/react/popover";
import { Ban, Check, ChevronDown, Minus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { exclude, include, type Option, restFor, termState } from "../../review/facets.ts";
import { matches, type Query } from "../../review/query.ts";
import type { ReviewSummary } from "../../schema/rpc.ts";
import { buttonVariants, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import { PRESSED } from "../ui/segmented.tsx";

/** A row of a menu: the term it writes, the text its search narrows by, and how it shows when not plain text. */
export type MenuRow = Option & { readonly label: string; readonly content?: ReactNode };

/** With more values than this, a search field narrows the rows. */
const SEARCH_AFTER = 7;

export type FilterMenuProps = {
  /** Which key the menu filters, as `data-filter-menu`. */
  readonly name: "repo" | "author" | "state";
  readonly label: string;
  /** What the search field finds, as in "Find repositories". */
  readonly finds: string;
  /** The rows in groups, a rule between each. */
  readonly groups: ReadonlyArray<ReadonlyArray<MenuRow>>;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly query: Query;
  readonly onQuery: (query: Query) => void;
  /** Whether the query holds a term of the menu's; the trigger then reads as pressed and the Clear row shows. */
  readonly active: boolean;
  /** The query without the menu's terms. */
  readonly clear: (query: Query) => Query;
};

export const FilterMenu = (props: FilterMenuProps) => (
  <Popover.Root>
    <Popover.Trigger
      data-filter-menu={props.name}
      data-active={props.active ? "" : undefined}
      className={cn(buttonVariants({ variant: "quiet", size: "sm" }), "gap-1", props.active && PRESSED)}
    >
      {props.label}
      <ChevronDown aria-hidden="true" className="size-3.5" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={4} align="start" className="z-40">
        <Popover.Popup
          aria-label={props.label}
          className="max-w-80 min-w-56 rounded-control border border-line bg-raised py-1 text-small shadow-md outline-none"
        >
          <MenuBody {...props} />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
);

/**
 * The popup's content, mounted while it is open so the search starts empty each time. Opening focuses its first
 * control, the search field when there is one, else the first row.
 */
const MenuBody = ({ finds, groups, reviews, query, onQuery, active, clear }: FilterMenuProps) => {
  const [search, setSearch] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const needle = search.trim().toLowerCase();
  const shown = groups
    .map((group) => group.filter((row) => row.label.toLowerCase().includes(needle)))
    .filter((group) => group.length > 0);
  const flat = shown.flat();

  const rowButtons = (): ReadonlyArray<HTMLButtonElement> => [
    ...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-row]") ?? []),
  ];

  // Arrows move between the rows, wrapping at the ends; Alt+Enter excludes, as Alt+click does.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const rows = rowButtons();
    const at = rows.findIndex((row) => row === event.target);
    if (at === -1) return;
    const focus = (index: number) => {
      event.preventDefault();
      rows[(index + rows.length) % rows.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return focus(at + 1);
      case "ArrowUp":
        return focus(at - 1);
      case "Home":
        return focus(0);
      case "End":
        return focus(rows.length - 1);
      case "Enter": {
        const row = flat[Number(rows[at]?.dataset.index)];
        if (!event.altKey || row === undefined) return;
        event.preventDefault();
        onQuery(exclude(query, row));
        return;
      }
      default:
        return;
    }
  };

  return (
    <>
      {total > SEARCH_AFTER ? (
        <div className="px-2 pb-1">
          <input
            type="search"
            aria-label={`Find ${finds}`}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              rowButtons()[0]?.focus();
            }}
            className={FIELD}
          />
        </div>
      ) : null}
      <ul ref={list} onKeyDown={onKeyDown} className="max-h-80 overflow-y-auto">
        {total === 0 ? (
          <li className="flex h-8 items-center px-2.5 text-muted">Nothing to filter by.</li>
        ) : flat.length === 0 ? (
          <li className="flex h-8 items-center px-2.5 text-muted">Nothing matches.</li>
        ) : (
          shown.map((group, at) =>
            group.map((row, index) => (
              <Row
                key={`${row.key}:${row.value}`}
                row={row}
                index={flat.indexOf(row)}
                first={at > 0 && index === 0}
                reviews={reviews}
                query={query}
                onQuery={onQuery}
              />
            )),
          )
        )}
        {active ? (
          <li className="mt-1 border-t border-separator pt-1">
            <button
              type="button"
              data-row=""
              onClick={() => {
                // The Clear row goes with the terms; focus stays in the list rather than falling to the popup.
                rowButtons()[0]?.focus();
                onQuery(clear(query));
              }}
              className={cn(TOUCH_TARGET, "flex h-8 w-full items-center px-2.5 text-left text-muted hover:bg-subtle focus-visible:bg-subtle")}
            >
              Clear
            </button>
          </li>
        ) : null}
      </ul>
    </>
  );
};

const Row = ({
  row,
  index,
  first,
  reviews,
  query,
  onQuery,
}: {
  readonly row: MenuRow;
  readonly index: number;
  /** The first row of a group after the first, under a rule. */
  readonly first: boolean;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly query: Query;
  readonly onQuery: (query: Query) => void;
}) => {
  const state = termState(query, row.key, row.value);
  // The reviews the rest of the query leaves with this value: the key's positive terms give way, its negated stay.
  const counted: Query = { terms: [...restFor(query, row).terms, { key: row.key, value: row.value, negated: false }] };
  const count = reviews.filter((review) => matches(counted, review)).length;
  const excluded = state === "excluded";
  return (
    <li
      className={cn(
        "group grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 pr-2.5 hover:bg-subtle focus-within:bg-subtle",
        first && "mt-1 border-t border-separator pt-1",
        count === 0 && "text-muted [&_.text-ink]:text-muted",
      )}
    >
      <button
        type="button"
        data-row=""
        data-index={index}
        aria-pressed={state === "included"}
        onClick={(event) => onQuery(event.altKey ? exclude(query, row) : include(query, row))}
        className={cn(TOUCH_TARGET, "col-span-3 grid h-8 w-full grid-cols-subgrid items-center pl-2.5 text-left outline-none")}
      >
        <span aria-hidden="true">
          {state === "included" ? <Check className="size-3.5" /> : excluded ? <Minus className="size-3.5 text-muted" /> : null}
        </span>
        {/* A voice is inline-flex and its name text-ink, so a strike and the muted colour go on its parts. */}
        <span className={cn("min-w-0 truncate", excluded && "text-muted line-through [&_*]:line-through [&_.text-ink]:text-muted")}>
          {row.content ?? row.label}
        </span>
        <span className="justify-self-end text-muted tabular-nums">{count}</span>
      </button>
      <button
        type="button"
        aria-label={`Exclude ${row.label}`}
        aria-pressed={excluded}
        onClick={() => onQuery(exclude(query, row))}
        className={cn(
          TOUCH_TARGET,
          "inline-grid size-6 place-items-center rounded-control text-muted hover:text-ink",
          excluded
            ? "opacity-100"
            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <Ban aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
};

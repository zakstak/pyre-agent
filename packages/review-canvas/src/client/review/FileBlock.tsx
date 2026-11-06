/**
 * A changed file as one block of the review page: a header with its fold toggle, path, counts, a control that opens
 * or closes every fold of its diff, and its Viewed control, and a body with its whole diff, the tour's notes in it, and
 * its comments, including those whose lines left. Viewed asks first while some of the file's changes were never shown.
 */
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Collapsible } from "@base-ui/react/collapsible";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FoldVertical,
  MessageSquare,
  UnfoldVertical,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileElementId } from "../../review/next.ts";
import { parseRows } from "../../review/patch.ts";
import { count, splitPath } from "../names.ts";
import { announce } from "../ui/announce.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Stat } from "../ui/stat.tsx";
import { Inline, LineCounts, Prose } from "../ui/text.tsx";
import { useAct, usePage } from "./act.ts";
import { DiffTable, useFileLayout } from "./Diff.tsx";
import {
  allFoldsOpen,
  allOpen,
  type DiffLayout,
  hasFolds,
  NO_FOLDS,
  unseenChanges,
} from "./diff-model.ts";
import { Narration } from "./Header.tsx";
import { showGuideStop } from "./navigate.ts";
import { SinceChanges } from "./Since.tsx";
import { Orphan } from "./Thread.tsx";
import {
  type BodyDiff,
  diffFoldsAtom,
  extraAtom,
  foldsAtom,
  shownChangesAtom,
  unchangedOpenAtom,
} from "./ui.ts";
import {
  type FileModel,
  PATCH_NOTE_TEXT,
  type PageModel,
  partSince,
  sinceNote,
} from "./view.ts";

/** Whether a file shows folded: the reviewer's choice for this round, or else the page's. */
const useFold = (model: FileModel) => {
  const { id, page } = usePage();
  const [folds, setFolds] = useAtom(foldsAtom({ id, round: page.round.round }));
  const path = model.file.path;
  const choice = folds[path];
  const folded = choice === undefined ? model.folded : choice === "closed";
  // From the folds as they are when it runs: a Viewed change sets it after the server answers.
  const set = (fold: "open" | "closed" | undefined) =>
    setFolds((now) => {
      const { [path]: _was, ...rest } = now;
      return fold === undefined ? rest : { ...rest, [path]: fold };
    });
  return { folded, chosen: choice !== undefined, set };
};

/**
 * The diff a file's body shows, and its patch: the file's changes since the last review while the page shows only
 * those, else its own patch, which is empty for a file without one.
 */
const bodyOf = (
  model: FileModel,
  page: PageModel,
): { readonly diff: BodyDiff; readonly patch: string } =>
  model.since?.kind === "changed" && page.since !== undefined
    ? {
        diff: {
          kind: "since",
          since: page.since.round,
          round: page.round.round,
        },
        patch: model.since.patch,
      }
    : {
        diff: { kind: "patch", digest: model.digest },
        patch: model.file.patch ?? "",
      };

const FilePath = ({ path }: { readonly path: string }) => {
  const { dir, base } = splitPath(path);
  return (
    <code title={path} className="break-all">
      <span className="text-muted">{dir}</span>
      <span className="font-semibold text-ink">{base}</span>
    </code>
  );
};

const Word = ({
  open,
  controls,
  warning = false,
  onToggle,
  children,
}: {
  readonly open: boolean;
  readonly controls: string;
  readonly warning?: boolean;
  readonly onToggle: () => void;
  readonly children: string;
}) => (
  <button
    type="button"
    aria-expanded={open}
    aria-controls={controls}
    onClick={onToggle}
    className={cn(
      TOUCH_TARGET,
      "inline-flex items-center gap-1 text-small font-medium hover:text-ink",
      warning ? "text-warning" : "text-muted",
    )}
  >
    {children}
    <ChevronDown
      aria-hidden="true"
      className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
    />
  </button>
);

const About = ({
  model,
  id,
}: {
  readonly model: FileModel;
  readonly id: string;
}) => {
  const { file } = model;
  return (
    <div id={id} className="flex flex-col gap-2 bg-surface px-4 py-3">
      <Narration>About this file</Narration>
      {file.summary === undefined ? null : <Prose text={file.summary} />}
      {(file.callouts ?? []).map((callout, at) => (
        <p key={at}>
          <strong>{callout.tag}.</strong> <Inline text={callout.text} />
        </p>
      ))}
      {file.pseudocode === undefined ? null : (
        <details>
          <summary className="font-semibold">Pseudocode</summary>
          <pre className="mt-1 overflow-x-auto rounded-control bg-code px-3 py-2 text-technical">
            {file.pseudocode}
          </pre>
        </details>
      )}
      {file.trace === undefined ? null : (
        <details>
          <summary className="font-semibold">Trace</summary>
          <dl className="mt-1 grid gap-1">
            {(
              [
                ["input", "Input"],
                ["before", "Before"],
                ["after", "After"],
              ] as const
            ).map(([part, label]) => (
              <div key={part}>
                <dt className="text-small font-semibold">{label}</dt>
                <dd className="m-0">
                  <pre className="overflow-x-auto rounded-control bg-code px-3 py-2 text-technical">
                    {file.trace?.[part]}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
};

/**
 * Asks before a file is marked viewed while some of its changes were never shown, and offers to show them. Esc leaves
 * the file as it was.
 */
const UnseenDialog = ({
  path,
  unseen,
  open,
  onOpenChange,
  onShow,
  onView,
}: {
  readonly path: string;
  readonly unseen: { readonly additions: number; readonly deletions: number };
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onShow: () => void;
  readonly onView: () => Promise<void>;
}) => {
  const show = useRef<HTMLButtonElement>(null);
  const lines = unseen.additions + unseen.deletions;
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/30" />
        <AlertDialog.Popup
          data-unseen-dialog
          initialFocus={show}
          className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-line bg-raised p-5 shadow-lg outline-none"
        >
          <AlertDialog.Title className="text-heading font-semibold">
            {count(lines, "changed line")} not shown yet
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-small text-muted">
            The page has not shown {lines === 1 ? "this line" : "these lines"}{" "}
            of <code className="break-all">{splitPath(path).base}</code> (
            <LineCounts
              additions={unseen.additions}
              deletions={unseen.deletions}
            />
            ). Show {lines === 1 ? "it" : "them"} before you mark the file
            viewed?
          </AlertDialog.Description>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button size="sm" data-view-anyway onClick={() => void onView()}>
              Mark viewed anyway
            </Button>
            <Button
              ref={show}
              size="sm"
              variant="primary"
              data-show-unseen
              onClick={onShow}
            >
              Show {lines === 1 ? "it" : "them"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};

/**
 * `onRequest` says which viewed state the reviewer asked for, until the page shows it; undefined when a refusal ends
 * the request. Marking the file viewed while some of its changes were never shown asks first; `onShow` shows them.
 */
const Viewed = ({
  model,
  onRequest,
  onShow,
}: {
  readonly model: FileModel;
  readonly onRequest: (viewed: boolean | undefined) => void;
  readonly onShow: (first: number) => void;
}) => {
  const { id, page } = usePage();
  const act = useAct();
  const { set } = useFold(model);
  const { file } = model;
  const body = bodyOf(model, page);
  const seen = useAtomValue(
    shownChangesAtom({ review: id, path: file.path, diff: body.diff }),
  );
  const rows = useMemo(() => parseRows(body.patch), [body.patch]);
  const unseen = model.approved ? undefined : unseenChanges(rows, seen);
  const [asking, setAsking] = useState(false);
  if (file.fingerprint === undefined) return null;
  // A closed review cannot change: its Viewed is a word, not a control.
  if (!page.writable)
    return model.approved ? (
      <span className="inline-flex items-center gap-1 text-small text-muted">
        <Check aria-hidden="true" className="size-3.5" /> Viewed
      </span>
    ) : null;
  const fingerprint = file.fingerprint;
  const toggle = async () => {
    onRequest(!model.approved);
    const outcome = await act(
      model.approved
        ? { kind: "unapprove", path: file.path }
        : { kind: "approve", path: file.path, fingerprint },
    );
    // Once the server took it, marking a file viewed or not hands its fold back to the page: viewing folds it.
    // A refused change leaves the file as the reviewer had it.
    if (outcome.ok) set(undefined);
    else onRequest(undefined);
    return outcome.ok;
  };
  return (
    <>
      <button
        type="button"
        data-viewed
        data-unseen={
          unseen === undefined ? undefined : unseen.additions + unseen.deletions
        }
        aria-pressed={model.approved}
        title={
          model.approved
            ? "Viewed. Activate to mark it not viewed"
            : "Mark this version of the file viewed"
        }
        onClick={() => {
          if (unseen === undefined) void toggle();
          else setAsking(true);
        }}
        className={cn(
          TOUCH_TARGET,
          "inline-flex h-7 items-center gap-1.5 rounded-control border px-2 text-small font-medium",
          model.approved
            ? "border-accent bg-selected text-ink"
            : "border-line bg-raised text-ink hover:bg-subtle",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-grid size-3.5 place-items-center rounded-sm border",
            model.approved
              ? "border-accent bg-accent text-on-accent"
              : "border-line",
          )}
        >
          {model.approved ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
        Viewed
      </button>
      {unseen === undefined ? null : (
        <UnseenDialog
          path={file.path}
          unseen={unseen}
          open={asking}
          onOpenChange={setAsking}
          onShow={() => {
            setAsking(false);
            onShow(unseen.first);
          }}
          onView={async () => {
            setAsking(false);
            // The dialog spoke for the key that opened it; the outcome is said here.
            if (await toggle()) announce(`${file.path} viewed.`);
          }}
        />
      )}
    </>
  );
};

/**
 * Opens every fold of a file's diff, its changes and its unchanged lines, and the file with them; once all are open,
 * folds them back as the page had them. A diff with nothing folded has no such control.
 */
const AllFolds = ({
  model,
  layout,
  folded,
  onOpen,
}: {
  readonly model: FileModel;
  readonly layout: DiffLayout;
  readonly folded: boolean;
  readonly onOpen: () => void;
}) => {
  const [folds, setFolds] = useAtom(
    diffFoldsAtom({ path: model.file.path, digest: model.digest }),
  );
  if (!hasFolds(layout)) return null;
  const open = !folded && allFoldsOpen(layout, folds);
  const Icon = open ? FoldVertical : UnfoldVertical;
  return (
    <button
      type="button"
      data-expand-all={open ? "open" : "folded"}
      onClick={() => {
        if (open) return setFolds(NO_FOLDS);
        setFolds(allOpen(layout));
        onOpen();
      }}
      className={cn(
        TOUCH_TARGET,
        "inline-flex items-center gap-1 text-small font-medium text-muted hover:text-ink",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {open ? "Collapse all" : "Expand all"}
    </button>
  );
};

/** In the source view, where files are in path order: a link to the stop of the guide that owns the file. */
const StopLink = ({ path }: { readonly path: string }) => {
  const { page, view } = usePage();
  const stop = page.stops.findIndex((item) =>
    item.owns.some((owned) => owned === path),
  );
  if (view !== "source" || stop === -1) return null;
  return (
    <a
      href={`#guide-stop-${stop + 1}`}
      data-stop-link={stop}
      onClick={(event) => {
        if (showGuideStop(stop)) event.preventDefault();
      }}
      className="text-small text-muted no-underline hover:underline"
    >
      Stop {stop + 1}
    </a>
  );
};

/** What a file's body says first while the page shows only what changed since the last review. */
const SinceNote = ({ model }: { readonly model: FileModel }) => {
  const { page } = usePage();
  const since = model.since;
  if (since === undefined || page.since === undefined) return null;
  return (
    <p
      data-since-note={since.kind}
      className={cn(
        "px-4 py-2 text-small",
        since.kind === "cannot_compare" ? "text-warning" : "text-muted",
      )}
    >
      {sinceNote(since, page.since.round)}
    </p>
  );
};

export const FileBlock = ({
  model,
  split,
}: {
  readonly model: FileModel;
  readonly split: boolean;
}) => {
  const { id, page } = usePage();
  const { file } = model;
  const { folded, chosen, set } = useFold(model);
  const setDiffFolds = useAtomSet(
    diffFoldsAtom({ path: file.path, digest: model.digest }),
  );
  const body = bodyOf(model, page);
  const layout = useFileLayout(model);
  const [aboutOpen, setAbout] = useAtom(
    extraAtom({ review: id, path: file.path, block: "about" }),
  );
  const [sinceOpen, setSince] = useAtom(
    extraAtom({ review: id, path: file.path, block: "since" }),
  );
  // The viewed state the reviewer asked for, until the page shows it. Meanwhile the file stays as it is: the page
  // still shows the file held open, and holding it would undo the fold that marking it viewed brings.
  const [requested, setRequested] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (requested !== undefined && model.approved === requested)
      setRequested(undefined);
  }, [requested, model.approved]);
  // A file held open stays open from then on, until the reviewer folds it or marks it viewed.
  useEffect(() => {
    if (model.held && !chosen && requested === undefined) set("open");
  }, [model.held, chosen, requested]);
  const table = `f${model.index}`;
  const bodyId = `body-${table}`;
  /** Shows the changes never shown: the file opens, and so does each fold of changes of its patch. */
  const showUnseen = (first: number) => {
    set("open");
    if (body.diff.kind === "patch") {
      const changes = allOpen(layout).changes;
      setDiffFolds((now) => ({
        ...now,
        changes: { ...now.changes, ...changes },
      }));
    }
    // The first of them comes into view once the rows are there.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector(
            `table[data-table="${body.diff.kind === "patch" ? table : `${table}-since`}"] [data-row="${first}"]`,
          )
          ?.scrollIntoView({ block: "center" }),
      ),
    );
  };
  const hasAbout =
    file.summary !== undefined ||
    file.pseudocode !== undefined ||
    file.trace !== undefined ||
    (file.callouts ?? []).length > 0;
  const status = model.status;
  return (
    <article
      id={fileElementId(file.path)}
      data-path={file.path}
      data-folded={folded}
      data-viewed={model.approved}
      className="mt-3 scroll-mt-(--sticky-top) rounded-panel bg-surface first-of-type:mt-4"
    >
      <header
        data-file-head
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-panel bg-surface px-2 py-1.5",
          // An open file's header has a hairline under it, so where it sticks it reads as a bar over the rows.
          folded
            ? "rounded-b-panel"
            : "border-b border-separator md:sticky md:top-[calc(var(--sticky-top)-0.5rem)] md:z-[5]",
        )}
      >
        {model.hasBody ? (
          <button
            type="button"
            data-fold
            aria-controls={bodyId}
            aria-expanded={!folded}
            aria-label={folded ? "Show diff" : "Hide diff"}
            onClick={() => set(folded ? "open" : "closed")}
            className={cn(
              TOUCH_TARGET,
              "inline-grid size-7 place-items-center rounded-control text-muted hover:bg-subtle hover:text-ink",
            )}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 transition-transform",
                folded && "-rotate-90",
              )}
            />
          </button>
        ) : null}
        <h3 tabIndex={-1} className="min-w-0 text-technical font-normal">
          <FilePath path={file.path} />
        </h3>
        <StopLink path={file.path} />
        {model.caption === undefined || model.caption === "" ? null : (
          <span
            title={model.caption}
            className="min-w-0 flex-[1_1_8rem] truncate text-small text-muted"
          >
            <Inline text={model.caption} />
          </span>
        )}
        {status === undefined ? null : status.kind === "since" ? (
          <Word
            open={sinceOpen}
            controls={`since-${table}`}
            warning={status.warning}
            onToggle={() => setSince(!sinceOpen)}
          >
            {status.text}
          </Word>
        ) : (
          <span
            className={cn(
              "text-small",
              status.warning ? "text-warning" : "text-muted",
            )}
          >
            {status.text}
          </span>
        )}
        {model.talk === undefined || !folded ? null : (
          <Stat icon={MessageSquare} title={model.talk}>
            {model.open}
          </Stat>
        )}
        <span className="ml-auto flex items-center gap-3 max-md:w-full max-md:justify-end">
          {file.patch === undefined ? null : (
            <LineCounts
              additions={file.additions}
              deletions={file.deletions}
              className="text-technical"
            />
          )}
          {body.diff.kind === "patch" ? (
            <AllFolds
              model={model}
              layout={layout}
              folded={folded}
              onOpen={() => set("open")}
            />
          ) : null}
          {hasAbout ? (
            <Word
              open={aboutOpen}
              controls={`about-${table}`}
              onToggle={() => setAbout(!aboutOpen)}
            >
              About
            </Word>
          ) : null}
          <Viewed model={model} onRequest={setRequested} onShow={showUnseen} />
        </span>
      </header>
      {hasAbout && aboutOpen ? (
        <About model={model} id={`about-${table}`} />
      ) : null}
      {status?.kind === "since" && sinceOpen ? (
        <div id={`since-${table}`}>
          <p className="bg-surface px-4 py-2 text-small text-muted">
            Changes since round {page.round.round - 1}
          </p>
          <DiffTable model={model} split={false} patch={status.patch} />
        </div>
      ) : null}
      {model.hasBody && !folded ? (
        <div id={bodyId} className="overflow-hidden rounded-b-panel">
          <SinceNote model={model} />
          {file.patch_note === undefined ? null : (
            <p className="px-4 py-2 text-small text-muted">
              {PATCH_NOTE_TEXT[file.patch_note]}
            </p>
          )}
          {body.diff.kind === "since" ? (
            <SinceChanges model={model} patch={body.patch} body={body.diff} />
          ) : file.patch === undefined ? null : (
            <DiffTable model={model} split={split} body={body.diff} />
          )}
          {model.orphans.length === 0 ? null : (
            <div>
              {model.orphans.map((comment) => (
                <Orphan key={comment.id} comment={comment} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
};

/**
 * Files one after another, as a stop or the source view lists them. While the page shows only what changed since the
 * last review, the files unchanged since then fold into one disclosure after the others; `list` names it, so going to
 * one of its files opens it.
 */
export const FileBlocks = ({
  models,
  split,
  list,
}: {
  readonly models: ReadonlyArray<FileModel>;
  readonly split: boolean;
  readonly list: number | "source";
}) => {
  const { id, page } = usePage();
  const [open, setOpen] = useAtom(unchangedOpenAtom({ review: id, list }));
  const { shown, unchanged } = partSince(models);
  return (
    <>
      {shown.map((model) => (
        <FileBlock key={model.file.path} model={model} split={split} />
      ))}
      {unchanged.length === 0 || page.since === undefined ? null : (
        <Collapsible.Root
          open={open}
          onOpenChange={setOpen}
          data-unchanged={list}
          className="mt-3"
        >
          <Collapsible.Trigger className="group flex min-h-11 items-center gap-1 text-small text-muted hover:text-ink">
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90"
            />
            {count(unchanged.length, "unchanged file")} since round{" "}
            {page.since.round}
          </Collapsible.Trigger>
          <Collapsible.Panel>
            {unchanged.map((model) => (
              <FileBlock key={model.file.path} model={model} split={split} />
            ))}
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </>
  );
};

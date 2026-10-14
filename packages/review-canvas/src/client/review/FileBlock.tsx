/**
 * A changed file as one block of the review page: a header with its fold toggle, path, counts, and Viewed control,
 * and a body with its whole diff, the tour's notes in it, and its comments, including those whose lines left.
 */
import { useAtom, useAtomSet } from "@effect/atom-react";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { fileElementId } from "../../review/next.ts";
import { splitPath } from "../names.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Inline, Prose } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage } from "./act.ts";
import { DiffTable } from "./Diff.tsx";
import { Orphan } from "./Thread.tsx";
import { extraAtom, foldsAtom, reattachAtom } from "./ui.ts";
import { type FileModel, PATCH_NOTE_TEXT } from "./view.ts";

/** Whether a file shows folded: the reviewer's choice for this round, or else the page's. */
export const useFold = (model: FileModel) => {
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

export const FilePath = ({ path }: { readonly path: string }) => {
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
    className={cn(TOUCH_TARGET, "cursor-pointer text-small font-medium hover:text-ink", warning ? "text-warning" : "text-muted")}
  >
    {children}
    <span aria-hidden="true"> {open ? "▴" : "▾"}</span>
  </button>
);

const About = ({ model, id }: { readonly model: FileModel; readonly id: string }) => {
  const { file } = model;
  return (
    <div id={id} className="flex flex-col gap-2 border-b border-separator bg-surface px-4 py-3">
      {file.summary === undefined ? null : <Prose text={file.summary} />}
      {(file.callouts ?? []).map((callout, at) => (
        <p key={at} className="max-w-reading">
          <strong>{callout.tag}.</strong> <Inline text={callout.text} />
        </p>
      ))}
      {file.pseudocode === undefined ? null : (
        <details>
          <summary className="cursor-pointer font-semibold">Pseudocode</summary>
          <pre className="mt-1 overflow-x-auto rounded-control bg-code px-3 py-2 text-technical">{file.pseudocode}</pre>
        </details>
      )}
      {file.trace === undefined ? null : (
        <details>
          <summary className="cursor-pointer font-semibold">Trace</summary>
          <dl className="mt-1 grid gap-1">
            {([["input", "Input"], ["before", "Before"], ["after", "After"]] as const).map(([part, label]) => (
              <div key={part}>
                <dt className="text-small font-semibold">{label}</dt>
                <dd className="m-0">
                  <pre className="overflow-x-auto rounded-control bg-code px-3 py-2 text-technical">{file.trace?.[part]}</pre>
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
 * `onRequest` says which viewed state the reviewer asked for, until the page shows it; undefined when a refusal ends
 * the request.
 */
const Viewed = ({
  model,
  onRequest,
}: {
  readonly model: FileModel;
  readonly onRequest: (viewed: boolean | undefined) => void;
}) => {
  const { page } = usePage();
  const act = useAct();
  const { set } = useFold(model);
  const { file } = model;
  if (file.fingerprint === undefined) return null;
  // A closed review cannot change: its Viewed is a word, not a control.
  if (!page.writable)
    return model.approved ? (
      <span className="text-small text-muted">
        <span aria-hidden="true">✓</span> Viewed
      </span>
    ) : null;
  const fingerprint = file.fingerprint;
  return (
    <button
      type="button"
      data-viewed
      aria-pressed={model.approved}
      title={model.approved ? "Viewed. Activate to mark it not viewed" : "Mark this version of the file viewed"}
      onClick={async () => {
        onRequest(!model.approved);
        const outcome = await act(
          model.approved ? { kind: "unapprove", path: file.path } : { kind: "approve", path: file.path, fingerprint },
        );
        // Once the server took it, marking a file viewed or not hands its fold back to the page: viewing folds it.
        // A refused change leaves the file as the reviewer had it.
        if (outcome.ok) set(undefined);
        else onRequest(undefined);
      }}
      className={cn(
        TOUCH_TARGET,
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border px-2 text-small font-medium",
        model.approved ? "border-accent bg-selected text-ink" : "border-line bg-raised text-ink hover:bg-subtle",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid size-3.5 place-items-center rounded-sm border text-[0.625rem] leading-none",
          model.approved ? "border-accent bg-accent text-on-accent" : "border-line",
        )}
      >
        {model.approved ? "✓" : ""}
      </span>
      Viewed
    </button>
  );
};

export const FileBlock = ({ model, split }: { readonly model: FileModel; readonly split: boolean }) => {
  const { page } = usePage();
  const { file } = model;
  const { folded, chosen, set } = useFold(model);
  const [aboutOpen, setAbout] = useAtom(extraAtom({ path: file.path, block: "about" }));
  const [sinceOpen, setSince] = useAtom(extraAtom({ path: file.path, block: "since" }));
  const setMoving = useAtomSet(reattachAtom);
  // The viewed state the reviewer asked for, until the page shows it. Meanwhile the file stays as it is: the page
  // still shows the file held open, and holding it would undo the fold that marking it viewed brings.
  const [requested, setRequested] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (requested !== undefined && model.approved === requested) setRequested(undefined);
  }, [requested, model.approved]);
  // A file held open stays open from then on, until the reviewer folds it or marks it viewed.
  useEffect(() => {
    if (model.held && !chosen && requested === undefined) set("open");
  }, [model.held, chosen, requested]);
  const table = `f${model.index}`;
  const body = `body-${table}`;
  const hasAbout =
    file.summary !== undefined || file.pseudocode !== undefined || file.trace !== undefined || (file.callouts ?? []).length > 0;
  const status = model.status;
  return (
    <article
      id={fileElementId(file.path)}
      data-file={model.index}
      data-path={file.path}
      data-folded={folded}
      data-viewed={model.approved}
      className="mt-4 scroll-mt-(--sticky-top) rounded-panel border border-separator bg-surface"
    >
      <header
        data-file-head
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-panel bg-surface px-2 py-1.5",
          folded ? "rounded-b-panel" : "border-b border-separator md:sticky md:top-[calc(var(--sticky-top)-0.5rem)] md:z-[5]",
        )}
      >
        {model.hasBody ? (
          <button
            type="button"
            data-fold
            aria-controls={body}
            aria-expanded={!folded}
            aria-label={folded ? "Show diff" : "Hide diff"}
            onClick={() => set(folded ? "open" : "closed")}
            className={cn(TOUCH_TARGET, "inline-grid size-7 cursor-pointer place-items-center rounded-control text-muted hover:bg-subtle hover:text-ink")}
          >
            <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", folded && "-rotate-90")} />
          </button>
        ) : null}
        <h3 tabIndex={-1} className="min-w-0 text-technical font-normal">
          <FilePath path={file.path} />
        </h3>
        {model.caption === undefined || model.caption === "" ? null : (
          <span title={model.caption} className="min-w-0 flex-[1_1_8rem] truncate text-small text-muted">
            <Inline text={model.caption} />
          </span>
        )}
        {status === undefined ? null : status.kind === "since" ? (
          <Word open={sinceOpen} controls={`since-${table}`} warning={status.warning} onToggle={() => setSince(!sinceOpen)}>
            {status.text}
          </Word>
        ) : (
          <span className={cn("text-small", status.warning ? "text-warning" : "text-muted")}>{status.text}</span>
        )}
        {model.talk === undefined || !folded ? null : <span className="text-small text-muted">{model.talk}</span>}
        <span className="ml-auto flex items-center gap-3 max-md:w-full max-md:justify-end">
          {file.patch === undefined ? null : (
            <span className="font-mono text-technical">
              <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
            </span>
          )}
          {hasAbout ? (
            <Word open={aboutOpen} controls={`about-${table}`} onToggle={() => setAbout(!aboutOpen)}>
              About
            </Word>
          ) : null}
          <Viewed model={model} onRequest={setRequested} />
        </span>
      </header>
      {hasAbout && aboutOpen ? <About model={model} id={`about-${table}`} /> : null}
      {status?.kind === "since" && sinceOpen ? (
        <div id={`since-${table}`} className="border-b border-separator">
          <p className="bg-surface px-4 py-2 text-small text-muted">Changes since round {page.round.round - 1}</p>
          <DiffTable model={model} split={false} patch={status.patch} />
        </div>
      ) : null}
      {model.hasBody && !folded ? (
        <div id={body} className="overflow-hidden rounded-b-panel">
          {file.patch_note === undefined ? null : (
            <p className="px-4 py-2 text-small text-muted">{PATCH_NOTE_TEXT[file.patch_note]}</p>
          )}
          {file.patch === undefined ? null : <DiffTable model={model} split={split} />}
          {model.orphans.length === 0 ? null : (
            <div data-orphans>
              {model.orphans.map((comment) => (
                <Orphan
                  key={comment.id}
                  comment={comment}
                  onMove={() => {
                    setMoving(comment.id);
                    toast("Select the lines this comment is about, with the + button or by dragging the line numbers. Esc cancels.");
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
};

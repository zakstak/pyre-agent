/**
 * Who is speaking, the same way everywhere: a filled disc in the voice's colour with its mark, then the name. An agent
 * is violet, the reviewer pink, a person on GitHub blue, and a GitHub bot muted.
 */
import { AtSign, Bot, Sparkles, User } from "lucide-react";
import { threadName } from "../names.ts";
import { cn } from "./cn.ts";

export type VoiceKind = "agent" | "you" | "github" | "bot";

/** A GitHub login's voice: a bot when it ends in `[bot]`, else a person. */
export const voiceOf = (login: string): "github" | "bot" => (login.endsWith("[bot]") ? "bot" : "github");

const DISC: Readonly<Record<VoiceKind, string>> = {
  agent: "bg-accent text-on-accent",
  you: "bg-action text-on-action",
  github: "bg-link text-white",
  bot: "bg-muted text-page",
};

const MARK: Readonly<Record<VoiceKind, typeof Sparkles>> = { agent: Sparkles, you: User, github: AtSign, bot: Bot };

/** A voice's mark: the filled disc in its colour with its glyph, without the name. */
export const VoiceMark = ({ kind }: { readonly kind: VoiceKind }) => {
  const Mark = MARK[kind];
  return (
    <span aria-hidden="true" className={cn("inline-grid size-4.5 flex-none place-items-center rounded-full", DISC[kind])}>
      <Mark className="size-3" strokeWidth={2.5} />
    </span>
  );
};

/**
 * A speaker. `name` is a thread's name for an agent and a login for GitHub: a person shows as `@login`, a bot as its
 * login without `[bot]` and a `bot` chip.
 */
export const Voice = ({ kind, name, title }: { readonly kind: VoiceKind; readonly name: string; readonly title?: string | undefined }) => {
  const shown = kind === "github" ? `@${name}` : kind === "bot" ? name.replace(/\[bot\]$/, "") : name;
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <VoiceMark kind={kind} />
      <span title={title} className="font-semibold text-ink">
        {shown}
      </span>
      {kind === "bot" ? (
        <span className="rounded-full border border-separator px-1.5 text-chip leading-4 text-muted">bot</span>
      ) : null}
    </span>
  );
};

/** An agent thread as a voice: its name, with its full label as the title when they differ. */
export const AgentVoice = ({ label }: { readonly label: string }) => {
  const name = threadName(label);
  return <Voice kind="agent" name={name} title={name === label ? undefined : label} />;
};

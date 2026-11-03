/**
 * The key help: every key the review page takes, from the list in keys.ts, and the switch for its single-letter keys.
 * It opens with ? or the keyboard button in the top bar, and closes with Esc, giving focus back where it was.
 */
import { Dialog } from "@base-ui/react/dialog";
import { useAtom } from "@effect/atom-react";
import { Keyboard, X } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { buttonVariants } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Kbd } from "../ui/kbd.tsx";
import { SHORTCUTS, type Shortcut } from "./keys.ts";
import { keyHelpAtom, shortcutsAtom } from "./ui.ts";

/** A shortcut's keys: each chord's keys joined by +, the chords by "or". */
const Keys = ({ keys }: { readonly keys: Shortcut["keys"] }) =>
  keys.map((chord, at) => (
    <Fragment key={chord.join("+")}>
      {at === 0 ? null : <span className="text-muted"> or </span>}
      {chord.map((key, place) => (
        <Fragment key={key}>
          {place === 0 ? null : <span className="text-muted">+</span>}
          <Kbd>{key}</Kbd>
        </Fragment>
      ))}
    </Fragment>
  ));

export const KeyHelp = () => {
  const [help, setHelp] = useAtom(keyHelpAtom);
  const [shortcuts, setShortcuts] = useAtom(shortcutsAtom);
  // Kept past the close, which Base UI reads after the state says closed.
  const returnTo = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    if (help.open) returnTo.current = help.returnTo;
  }, [help]);
  return (
    <Dialog.Root
      open={help.open}
      onOpenChange={(open) =>
        setHelp(open ? { open: true, returnTo: undefined } : { open: false })
      }
    >
      <Dialog.Trigger
        data-key-help-open
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className={cn(
          buttonVariants({ variant: "quiet", size: "sm" }),
          "px-1.5 text-muted hover:text-ink max-md:hidden",
        )}
      >
        <Keyboard aria-hidden="true" className="size-4" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/20" />
        <Dialog.Popup
          data-key-help
          finalFocus={() =>
            returnTo.current?.isConnected === true ? returnTo.current : true
          }
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-line bg-raised px-5 py-4 text-small text-ink shadow-lg outline-none"
        >
          <div className="flex items-center justify-between gap-4">
            <Dialog.Title className="text-heading font-semibold">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className={cn(
                buttonVariants({ variant: "quiet", size: "sm" }),
                "px-1.5",
              )}
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          {SHORTCUTS.map((group) => (
            <section key={group.title} className="mt-4">
              <h3 className="font-semibold">{group.title}</h3>
              <p className="text-muted">{group.when}</p>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[12.5rem_1fr]">
                {group.shortcuts.map((item) => (
                  <Fragment key={item.does}>
                    <dt className="whitespace-nowrap">
                      <Keys keys={item.keys} />
                    </dt>
                    <dd className="m-0">{item.does}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
          <label className="mt-5 flex w-fit items-center gap-2 font-semibold">
            <input
              type="checkbox"
              data-shortcuts
              checked={shortcuts}
              onChange={(event) => setShortcuts(event.currentTarget.checked)}
              className="size-4 accent-accent"
            />
            Single-letter keys
          </label>
          <p className="mt-1 text-muted">
            Turn these off when speech or screen reader software types letters
            on this page. The keys on a file's heading and lines still work.
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

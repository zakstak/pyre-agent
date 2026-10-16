/** One thing a reviewer sets, on a settings page: a heading, a line on what it does, and its control. */
import { Collapsible } from "@base-ui/react/collapsible";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { landOnHash } from "./page.tsx";

/** A setting that opens for direct links, repeated same-page links, and newly applicable defaults. */
export const SettingDisclosure = ({
  id,
  defaultOpen = false,
  ...props
}: Omit<
  ComponentProps<typeof Collapsible.Root>,
  "open" | "onOpenChange" | "id"
> & { readonly id: string }) => {
  const [open, setOpen] = useState(
    () => defaultOpen || location.hash === `#${id}`,
  );
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  useEffect(() => {
    const reveal = () => {
      if (location.hash === `#${id}`) setOpen(true);
    };
    const followed = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        link instanceof HTMLAnchorElement &&
        (link.target === "" || link.target === "_self") &&
        !link.hasAttribute("download") &&
        link.origin === location.origin &&
        link.pathname === location.pathname &&
        link.search === location.search &&
        link.hash === `#${id}`
      )
        setOpen(true);
    };
    addEventListener("hashchange", reveal);
    document.addEventListener("click", followed);
    return () => {
      removeEventListener("hashchange", reveal);
      document.removeEventListener("click", followed);
    };
  }, [id]);
  useEffect(() => {
    if (open && location.hash === `#${id}`) landOnHash();
  }, [id, open]);
  return (
    <Collapsible.Root {...props} id={id} open={open} onOpenChange={setOpen} />
  );
};

export const Setting = ({
  id,
  title,
  blurb,
  children,
}: {
  /** The element's ID, which the settings search links to. */
  readonly id: string;
  readonly title: string;
  readonly blurb?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-16">
    <h2 id={`${id}-title`} className="text-heading font-semibold">
      {title}
    </h2>
    {blurb === undefined ? null : (
      <p className="mt-0.5 text-small text-muted">{blurb}</p>
    )}
    <div className="mt-3">{children}</div>
  </section>
);

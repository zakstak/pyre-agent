/** One thing a reviewer sets, on a settings page: a heading, a line on what it does, and its control. */
import type { ReactNode } from "react";

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
    {blurb === undefined ? null : <p className="mt-0.5 text-small text-muted">{blurb}</p>}
    <div className="mt-3">{children}</div>
  </section>
);

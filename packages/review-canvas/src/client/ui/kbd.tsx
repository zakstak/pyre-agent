/** A key as the page names it in a hint or the key help. */
export const Kbd = ({ children }: { readonly children: string }) => (
  <kbd className="inline-block rounded-sm border border-line px-[0.3em] leading-[1.3] font-semibold text-muted">
    {children}
  </kbd>
);

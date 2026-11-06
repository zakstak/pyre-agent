/**
 * Words for a reader who hears the page, said without moving focus: what a key did when focus alone cannot say it,
 * such as which lines a selection now spans. One polite live region, made on first use, says the latest words.
 */
let region: HTMLElement | undefined;

export const announce = (message: string): void => {
  if (region === undefined) {
    region = document.createElement("div");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "status");
    region.dataset.announce = "";
    region.className = "sr-only";
    document.body.append(region);
  }
  const target = region;
  // Emptied first and filled a frame later, so the same words said twice are heard twice.
  target.textContent = "";
  requestAnimationFrame(() => {
    target.textContent = message;
  });
};

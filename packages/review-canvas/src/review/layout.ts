/** The cookie that keeps the reviewer's diff layout, which the server reads when it renders and the page sets. */
export const LAYOUT_COOKIE = "review-canvas-layout";

/** The header a page too narrow for the split layout sends when it fetches its markup, with the value "1". */
export const NARROW_HEADER = "x-review-canvas-narrow";

/** The widths at which a page shows the unified layout whatever the cookie says. main.css hides the toggle there. */
export const NARROW_QUERY = "(width < 48rem)";

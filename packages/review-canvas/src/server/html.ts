/**
 * Markup rendered on the server. Interpolated values are escaped unless they are already `Html`, so markup enters a
 * page only through `html` templates.
 */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export type Interpolation =
  | Html
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Interpolation>;

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "\r": "&#13;",
};

const render = (value: Interpolation): string => {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value).replace(
    /[&<>"'\r]/g,
    (character) => escapes[character] ?? character,
  );
};

export const html = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<Interpolation>
): Html =>
  new Html(
    strings.reduce(
      (out, part, index) => out + render(values[index - 1]) + part,
    ),
  );

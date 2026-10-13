/**
 * A line diff of two texts as a unified patch, for what changed in a file between two rounds. Each round's patch
 * compares with the base, so for a file the agent changed again, or one new to the repository, only this shows what
 * the latest round changed.
 */

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

const lines = (text: string): Array<string> => {
  if (text === "") return [];
  const split = text.split("\n");
  if (text.endsWith("\n")) split.pop();
  return split;
};

/**
 * Myers' shortest edit script between two line lists, or undefined when the texts differ in more lines than `limit`:
 * the trace grows with the square of the distance.
 */
const editScript = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  limit: number,
): Array<Op> | undefined => {
  const n = a.length;
  const m = b.length;
  const offset = n + m;
  let v = new Int32Array(2 * offset + 2);
  const trace: Array<Int32Array> = [];
  for (let d = 0; d <= Math.min(offset, limit); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
    v = v.slice();
  }
  return undefined;
};

const backtrack = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  trace: ReadonlyArray<Int32Array>,
  offset: number,
  depth: number,
): Array<Op> => {
  const ops: Array<Op> = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down =
      k === -d ||
      (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const previousK = down ? k + 1 : k - 1;
    const previousX = v[offset + previousK] ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ kind: " ", text: a[--x] ?? "" });
      y--;
    }
    if (down) ops.push({ kind: "+", text: b[--y] ?? "" });
    else ops.push({ kind: "-", text: a[--x] ?? "" });
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", text: a[--x] ?? "" });
    y--;
  }
  return ops.reverse();
};

/**
 * The unified patch from one text to another with `context` unchanged lines around each change, or undefined when
 * they are equal or differ too much to diff. It starts at its first hunk header, as review patches do.
 */
export const unifiedDiff = (
  before: string,
  after: string,
  options: { readonly context?: number; readonly limit?: number } = {},
): string | undefined => {
  const context = options.context ?? 3;
  const ops = editScript(lines(before), lines(after), options.limit ?? 2000);
  if (ops === undefined || ops.every((op) => op.kind === " ")) return undefined;
  // Line numbers of each op on both sides, and which ops a hunk keeps: changes and the context around them.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, at) => {
    if (op.kind === " ") return;
    for (
      let i = Math.max(0, at - context);
      i <= Math.min(ops.length - 1, at + context);
      i++
    )
      keep[i] = true;
  });
  const out: Array<string> = [];
  let oldLine = 1;
  let newLine = 1;
  let at = 0;
  while (at < ops.length) {
    if (!keep[at]) {
      const op = ops[at] as Op;
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
      at++;
      continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const body: Array<string> = [];
    while (at < ops.length && keep[at]) {
      const op = ops[at] as Op;
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
      at++;
    }
    const oldCount = oldLine - oldStart;
    const newCount = newLine - newStart;
    out.push(
      `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
      ...body,
    );
  }
  return `${out.join("\n")}\n`;
};

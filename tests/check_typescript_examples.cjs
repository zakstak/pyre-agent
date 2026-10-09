/* Checks the corrected documentation examples with an existing TypeScript CLI.
 * Run: node tests/check_typescript_examples.cjs /path/to/typescript/lib/tsc.js
 * Does not install TypeScript or change project compiler settings.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const compiler = process.argv[2];
if (!compiler || !fs.existsSync(compiler)) throw new Error('Pass an existing TypeScript CLI path.');
const docs = fs.readFileSync(path.join(__dirname, '../skills/typescript-best-practices/references/patterns.md'), 'utf8').replace(/\r\n/g, '\n');
function section(title) {
  const start = docs.indexOf('## ' + title + '\n');
  assert.ok(start >= 0, title);
  const end = docs.indexOf('\n## ', start + 4);
  return docs.slice(start, end < 0 ? undefined : end);
}
const blocks = [...section('Constructive modeling').matchAll(/```ts\n([\s\S]*?)```/g)].map(m => m[1]);
assert.equal(blocks.length, 4);
const nonEmpty = blocks[0].split('// Don\'t')[0] + blocks[0].slice(blocks[0].indexOf('// Do:'));
const duration = blocks[3].slice(blocks[3].indexOf('type DurationMs'));
const satisfies = [...section('`satisfies` over `as`').matchAll(/```ts\n([\s\S]*?)```/g)][0][1];
const assertions = `
function typeRejections(xs: NonEmpty<string>, pairs: Pairs<string>) {
  // @ts-expect-error A readonly non-empty snapshot cannot be emptied.
  xs.pop();
  // @ts-expect-error Pair collection cannot be structurally mutated.
  pairs.push(['x', 'y']);
  // @ts-expect-error An individual pair cannot be emptied.
  pairs[0]?.pop();
  // @ts-expect-error Raw numbers cannot bypass the duration constructor.
  const duration: DurationMs = -1;
}
const source = ['x'];
const snapshot = snapshotNonEmpty(source);
source.pop();
if (!snapshot || snapshot[0] !== 'x' || pickWinner(snapshot) !== 'x') throw new Error('Snapshot alias regression');
if (snapshotNonEmpty([]) !== undefined) throw new Error('Empty snapshot accepted');
if (snapshotNonEmpty(new Array<string>(1)) !== undefined) throw new Error('Sparse head accepted');
const sparseTail = ['x', 'y'];
delete sparseTail[1];
if (snapshotNonEmpty(sparseTail) !== undefined) throw new Error('Sparse tail accepted');
const exactTheme: 'dark' = config.theme;
const exactColumns: 3 = config.cols;
for (const n of [-1, NaN, Infinity, -Infinity]) {
  let rejected = false;
  try { parseDurationMs(n); } catch { rejected = true; }
  if (!rejected) throw new Error('Invalid duration accepted: ' + n);
}
for (const n of [0, 1, 1.5]) if (parseDurationMs(n) !== n) throw new Error('Valid duration changed');
`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyre-ts-examples-'));
try {
  const file = path.join(temp, 'examples.ts');
  fs.writeFileSync(file, [nonEmpty, blocks[1], blocks[2], duration, satisfies, assertions].join('\n'));
  const result = spawnSync(process.execPath, [compiler, '--strict', '--noUncheckedIndexedAccess', '--target', 'ES2022', '--module', 'commonjs', '--outDir', path.join(temp, 'out'), file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const runtime = spawnSync(process.execPath, [path.join(temp, 'out/examples.js')], { encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  console.log('PASS: corrected examples compile with strict indexed-access checks; mutation and raw durations rejected; snapshots survive alias mutation; invalid durations rejected.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

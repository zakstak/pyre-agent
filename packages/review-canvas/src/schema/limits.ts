/**
 * Every size, count, and character limit the review input and feedback enforce. Text limits count UTF-16 code units,
 * JavaScript's string length, so an emoji counts as 2. Anchor offsets use the same unit.
 *
 * The values come from the Python review canvas (`render_review.py`, `feedback_contract.py`, and the page's
 * `feedback.js` and `review.js`) unless a comment marks them as new.
 */

const MiB = 1024 * 1024;

/**
 * A review input: what an agent publishes as a round, including the collector's working tree snapshot. It counts the
 * UTF-8 bytes of the document as written, and the input schema checks it too.
 */
export const MAX_INPUT_BYTES = 32 * MiB;
/** A feedback export or import, as the exported document's UTF-8 bytes. The feedback schema checks it too. */
export const MAX_FEEDBACK_BYTES = 8 * MiB;
/** The deepest JSON value either format allows: the root is depth 0, and each array or object adds one. */
export const MAX_JSON_DEPTH = 32;

/** Changed files in one review input, and file entries in feedback. */
export const MAX_FILES = 2000;
/** Callouts on one input file. */
export const MAX_CALLOUTS = 100;
/** One patch, in UTF-16 code units. */
export const MAX_PATCH_UNITS = 4 * MiB;
/** LF-delimited lines in one patch. */
export const MAX_PATCH_LINES = 10_000;
/** The last zero-based patch row an anchor can name. */
export const MAX_ROW = MAX_PATCH_LINES - 1;
/** LF-delimited lines in all patches of one input. */
export const MAX_TOTAL_PATCH_LINES = 50_000;
/**
 * Feedback lists every path twice, in files and approvals, so the paths of one input must fit this many bytes as
 * JSON, with {@link FEEDBACK_BYTES_PER_FILE} more for each file. It refuses early an input whose feedback could
 * barely hold a note. It guarantees nothing: notes and comments can still push feedback past
 * {@link MAX_FEEDBACK_BYTES}, which the feedback schema refuses as a whole.
 */
export const MAX_FEEDBACK_PATH_BYTES = 6 * MiB;
export const FEEDBACK_BYTES_PER_FILE = 200;

/** Approvals in feedback, with unique paths. */
export const MAX_APPROVALS = 2000;
/** Comments in feedback, with unique IDs. */
export const MAX_COMMENTS = 1000;
/** Earlier anchors one comment keeps after manual reattachment. */
export const MAX_ANCHOR_HISTORY = 20;
/** Reviewer replies to one comment. */
export const MAX_REVIEWER_REPLIES = 200;
/** Agent answers in one review. The Python version held them in the round input, with the same limit. */
export const MAX_AGENT_ANSWERS = 5000;
/** New: replies imported from GitHub to one comment, as many as the reviewer may write. */
export const MAX_GITHUB_REPLIES = 200;
/** New: agent threads one review names. */
export const MAX_THREADS = 100;
/** Earlier rounds whose notes feedback keeps. The Python version called them retained reviews. */
export const MAX_EARLIER_ROUNDS = 50;
/**
 * All notes, comment and reply bodies, blockers, quotes, and anchor paths in one feedback document, in UTF-16 code
 * units.
 */
export const MAX_FEEDBACK_TEXT_UNITS = 2 * MiB;

/** Any text field without its own limit: titles, summaries, analysis, notes, bodies, blockers, and quotes. */
export const MAX_TEXT_UNITS = 20_000;
/**
 * New: a comment or reply imported from GitHub. GitHub allows 65,536 characters, and a character can take two UTF-16
 * code units.
 */
export const MAX_GITHUB_BODY_UNITS = 2 * 65_536;
/** Repository paths and working tree roots. */
export const MAX_PATH_UNITS = 4096;
/** A working tree's branch name. */
export const MAX_BRANCH_UNITS = 1024;
/** A callout's tag. */
export const MAX_CALLOUT_TAG_UNITS = 100;
/** The context kept on each side of an anchor's quote. */
export const MAX_CONTEXT_UNITS = 80;
/** Why a comment is attached or orphaned. */
export const MAX_ATTACHMENT_REASON_UNITS = 200;
/** New: a thread's label, and a host's session ID. */
export const MAX_LABEL_UNITS = 200;

/** Local IDs of comments, replies, threads, and reviews: 1 to this many letters, digits, hyphens, or underscores. */
export const MAX_ID_LENGTH = 80;
/** Line counts and the declared changed-file count. Booleans are not counts. */
export const MAX_COUNT = 10 ** 12;
/**
 * Anchor and attachment offsets into a patch's rows joined with LF, which is no longer than the patch. An end offset
 * is exclusive, so it can equal the length. The Python version allowed 50,000,000, more than any patch holds.
 */
export const MAX_OFFSET = MAX_PATCH_UNITS;
/** Source line numbers an anchor names. Hunk headers allow 12 digits. */
export const MAX_LINE = 10 ** 12;

/**
 * The control characters no text field may hold: C0 controls other than tab, LF, and CR. Unpaired UTF-16 surrogates
 * are refused too. Patches from the collector show other hidden characters as replacements instead.
 */
export const REFUSED_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

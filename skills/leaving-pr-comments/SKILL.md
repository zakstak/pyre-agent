---
name: leaving-pr-comments
description: Use when leaving comments on GitHub.
metadata:
  version: "1.0.1"
---

# Leaving PR Comments

Prefix every agent-authored comment left on the user's behalf with this GitHub
note callout:

```md
> [!NOTE]
> 🤖 **<model> responding with direction from <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment.

If the harness does not expose a model name, use the harness name. Do not guess.

Use the directing user's name from explicit instructions or installed user
context. Keep personal names in that context, outside this skill. If no name is
available, use `the user`. Do not infer a name from the repository owner or
authenticated GitHub account.

Before posting, check the entire comment, including quoted text and attachments,
for secrets and private details.

Keep the attribution inside the note and the actual reply outside it. The
context line must start with the robot emoji. Do not add a horizontal rule,
Setext underline, heading, signature footer, or a second attribution.

Apply this format to top-level PR comments, inline review comments, replies to
bots or reviewers, and written explanations used before resolving or dismissing
feedback. Do not add it to PR descriptions, commit messages, or text the user
explicitly asked to post verbatim without attribution.

Write the comment itself in a direct style:

- Lead with the conclusion.
- Cite the relevant code, behavior, check, or reproduction.
- Keep it concise and avoid filler, canned thanks, or status narration.
- Distinguish verified facts from judgment.

Preview the final Markdown before posting so quoting and blank lines render as
shown. After posting, verify that GitHub returned the comment or review URL.
Resolve a review thread only after its response was posted successfully.

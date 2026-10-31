---
name: pr-screenshots
description:
  "Use when a pull request needs visual evidence of changes to interfaces,
  charts, terminal output, or rendered documents. Capture comparable images
  and prepare or publish them within the task's authorized scope."
metadata:
  version: "1.0.0"
---

# PR screenshots

Give reviewers enough visual evidence to understand the change without running
the project. Use the repository's existing capture tools, artifact storage, and
PR conventions. Adapt to the available browser, terminal, and hosting tools.

Upload images and update the PR when the task authorizes those actions.
Otherwise, prepare the images and description locally.

## Choose what to show

Capture the states that explain the change. Include responsive layouts,
interaction states, or error conditions when they matter.

Prefer a few focused images over a gallery. Use a short recording when motion or
interaction carries information that screenshots cannot show.

For terminal output, prefer a fenced text block unless appearance is part of the
change.

## Capture a trustworthy comparison

Capture the before state before editing when practical. Use the revision that
represents the behavior being changed, usually the PR's merge base with its
target branch.

If changes already exist, run the baseline in a separate checkout or worktree.
Preserve the current checkout and uncommitted work. Identify a reconstructed
baseline when its source matters to the comparison.

Keep these conditions consistent between before and after, except when a
condition is itself the subject of the change:

- Viewport dimensions, zoom, and device scale.
- Route, scroll position, and crop.
- Theme, locale, and relevant preferences.
- Input data and interaction state.

Wait for fonts, images, and required data to load. Control animations and
volatile content when they obscure the comparison.

Capture the actual implementation. Do not substitute a mockup or generated image
for evidence.

If no meaningful before state exists, show the result and label it clearly. If a
baseline cannot be reproduced, state that limitation.

Keep a short local capture record with the before and after revisions, any
uncommitted changes, route or command, viewport, relevant fixtures, and
reproduction steps. Keep the record with the local artifacts unless the
repository specifies another location.

## Keep images readable

Keep zoom and device scale consistent. Prefer 1× captures for ordinary web
comparisons. Preserve the target device scale when it matters. Avoid resampling
captures afterward.

Crop to the relevant area while preserving enough context to understand it. Use
the same framing for each comparison.

Use PNG for interfaces and text unless another format preserves readability with
a substantially smaller file.

Control display size in the PR markup when needed:

```html
<img src="IMAGE_URL" width="720" alt="Settings form with aligned labels and inputs">
```

Add arrows, boxes, or numbered callouts only when the difference is difficult to
find. Keep the original capture and avoid covering relevant content.

## Publish through the established workflow

Use an available attachment tool, supported upload API, browser upload flow, or
approved artifact host.

Choose URLs that:

- Remain available throughout review.
- Render inline in the PR description.
- Work for the intended reviewers.
- Preserve the project's access restrictions.

Inspect images for credentials, personal information, and unrelated private
content before uploading. Prefer sanitized fixtures during capture.

Keep screenshot-only files outside the product tree unless repository
conventions require otherwise. Follow existing asset-hosting conventions.
Introduce a new hosting service or asset branch only when authorized.

If upload is unavailable, retain the local artifacts and report the blocker. Do
not present local paths or invented URLs as working PR images.

## Update the PR description

Preserve the existing description and required template sections. Add visible
images near the explanation of the change. Keep the primary evidence outside
collapsed sections.

Use brief captions that tell reviewers what to notice:

```markdown
### Filter alignment

**Before:** Adjacent buttons draw overlapping borders.

![Filter buttons before the change](BEFORE_IMAGE_URL)

**After:** The buttons share a single border and retain their focus indicators.

![Filter buttons after the change](AFTER_IMAGE_URL)
```

For several distinct changes, repeat this pattern under descriptive headings.
Include viewport or environment details only when they affect interpretation.

## Verify the published result

Open the rendered PR description and confirm that:

- Images load and the labels match their contents.
- Text remains readable at the displayed size.
- Comparisons use matching states and framing, with any differences explained.
- Captures reflect the current implementation.

Replace stale screenshots after relevant changes. Use a new filename or
immutable URL for revised captures, update the description, and verify the
rendered result.

Report capture, upload, and embedding status accurately. Screenshots document
appearance. Describe functional checks separately.

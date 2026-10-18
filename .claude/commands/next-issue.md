# /next-issue

You are helping the maintainer of the Accord Protocol project create GitHub issues one at a time.

## What to do when this skill is invoked

### Step 1 — Mark the previous issue as done (if any)
Read `issue-tracker.md`. Find any issue marked `[~]` (in progress). Change it to `[x]` (done) and update the **Created** count in the progress line at the top.

### Step 2 — Pick the next issue
Find the first `[ ]` entry in `issue-tracker.md`. That is the issue to work on next. Note its number and title.

### Step 3 — Mark it in progress
Change its `[ ]` to `[~]` in `issue-tracker.md` so it is clear which one is being worked on.

### Step 4 — Determine the issue type
Look at the subsection heading directly above the issue in `issue-tracker.md`. The heading uses the format `Section — Subsection` (e.g. `Contract — Security & Validation`, `Frontend — Landing Page`, `Docs — Deployment`).

- The **top-level section** is the word before the dash: `Frontend`, `Contract`, or `Docs`.
- The **subcategory** is the word or phrase after the dash.

Normalise the label to one of these exact values (pick the closest match):

- **Frontend** subcategories: `Dashboard`, `Modal`, `Routing`, `Wallet`, `History & Filtering`, `Events`, `Accessibility`, `Testing`, `Code Quality`, `Landing Page`, `Documentation Page`
- **Smart Contract** subcategories: `New Feature`, `Testing`, `Security`, `Optimisation`, `Build & CI`
- **Docs** subcategories: `Setup & Onboarding`, `API Reference`, `Deployment`, `Security`, `Architecture`, `User Guides`, `Tutorial`, `Contributing`

Note: issues from 33 onwards use `Contract —` in the tracker header, which normalises to `Smart Contract` in the label. So `Contract — New Features` → `Smart Contract — New Feature`, `Contract — Security & Validation` → `Smart Contract — Security`, and so on.

Format the full type label as: `[Top-level] — [Subcategory]`

Examples: `Frontend — Testing`, `Smart Contract — Security`, `Docs — Tutorial`, `Smart Contract — New Feature`, `Docs — Architecture`, `Frontend — Landing Page`

### Step 5 — Research the codebase
Read only the files that are relevant to the chosen issue. Use the file tree and existing source files to understand what already exists, what is missing, and what files a contributor would need to touch. Do not read every file — be targeted.

Some issues cover multiple related tasks that were merged into a single GitHub issue. In that case, the issue body should cover all the tasks listed in the title, treating them as a single coherent unit of work with shared acceptance criteria.

### Step 6 — Write current-issue.md
Overwrite `current-issue.md` with a clean GitHub issue body using the format below. No meta-instructions, no code snippets, no internal notes — only what a contributor on GitHub would read.

---

## Output format for current-issue.md

```
## Title
[The issue title — same wording as in issues.md]

**[Top-level] — [Subcategory]**

## Summary
[One or two sentences describing what this issue adds or fixes and why it matters to the user.]

## Background
[Any existing code or contract behaviour the contributor needs to know about before starting. Reference specific files by name. Keep it short — 2 to 4 sentences.]

## What Needs to Be Done

1. [Clear instruction describing the first change needed, which file to touch, and what outcome it should produce. No code.]
2. [Next change.]
3. [Continue for each logical step.]

## Acceptance Criteria
- [ ] [Observable condition that proves the work is complete.]
- [ ] [Another condition.]
- [ ] [Continue until all success states are covered.]

## Files to Look At
- `path/to/file.ts` — [one-line note on why it is relevant]
- `path/to/other.tsx` — [one-line note]

**Difficulty**: Easy / Medium / Hard
```

### Rules for writing the issue
- No code blocks of any kind
- Each step in "What Needs to Be Done" says what to do and where, not how to implement it
- Acceptance criteria must be observable — something a reviewer can check without reading source code
- Keep the whole issue under 400 words
- Use plain English, no jargon that a mid-level frontend or Rust contributor would not know
- For merged issues covering multiple tasks, list each task as its own numbered step and give each a separate acceptance criteria checkbox
- Never reference other issues by number (e.g. do not write "#115" or "issue #121"). If you need to refer to a related feature, describe it by name only (e.g. "the DocsPage layout component" not "issue #115")

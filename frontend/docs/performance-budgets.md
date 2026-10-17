# Frontend performance budgets

Two CI checks keep the frontend fast: a **bundle-size budget** (bytes shipped)
and a **load-performance budget** (how long a key page takes to become
interactive). Both fail the build when a budget is exceeded. Raising a budget is
a deliberate, reviewed change — never a way to make a red build green.

## Bundle-size budget

- Script: `frontend/scripts/check-bundle-budget.mjs`
- Budgets: `frontend/bundle-budget.json`
- Baseline (for the delta report): `frontend/bundle-baseline.json`
- Command: `npm run check:bundle` (run after `npm run build`)

The script walks `dist/`, gzip-compresses every asset, and compares four
metrics against the budget:

| Metric | Meaning |
| --- | --- |
| `totalJsGzipBytes` | Sum of all JavaScript assets, gzip-compressed |
| `totalCssGzipBytes` | Sum of all CSS assets, gzip-compressed |
| `largestChunkGzipBytes` | Largest single JavaScript chunk |
| `maxChunks` | Number of emitted JavaScript chunks |

It prints a table, writes `frontend/bundle-report.json`, appends to the GitHub
Actions job summary, and reports the delta against `bundle-baseline.json`.

## Load-performance budget

- Script: `frontend/scripts/check-performance-budget.mjs`
- Budgets: `frontend/performance-budget.json`
- Command: `npm run perf` (with `vite preview` running on port 4173)

The script launches the Playwright Chromium that CI already installs, loads the
configured page three times, and compares the **median** of these metrics:

| Metric | Meaning |
| --- | --- |
| `firstContentfulPaintMs` | First Contentful Paint |
| `domContentLoadedMs` | DOMContentLoaded |
| `loadEventMs` | Window `load` event |

## Raising a budget deliberately

Only raise a budget when the increase is intentional and understood.

1. Confirm the growth is expected. Inspect `frontend/bundle-report.json` and the
   largest-asset list to see *what* grew. A sudden jump usually means an
   accidental heavy import.
2. Adjust the number in `frontend/bundle-budget.json` or
   `frontend/performance-budget.json`.
3. For bundle size, refresh the rolling baseline so future PRs report deltas
   from the new normal:

   ```bash
   npm run build
   npm run check:bundle -- --update-baseline
   ```

4. Explain the reason in the pull request description (for example, "adds the
   charts library, +120 kB gzip, offset by lazy-loading the analytics route").
5. Keep the change in its own commit so the budget move is easy to review and
   revert separately from the code that needs it.

Prefer reducing the size first: code-split routes with dynamic `import()`,
lazy-load charts and PDF export, and drop unused dependencies.

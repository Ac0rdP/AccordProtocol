# Frontend testing

How the frontend suite is run, how contract calls are simulated, and how test
coverage is measured and enforced.

## Running the suite

| Command | What it does |
| --- | --- |
| `npm test` | Run the unit suite once, no coverage. |
| `npm run test:coverage` | Run the suite and enforce coverage thresholds. |
| `npm run test:coverage:ci` | Same, but emits the `lcov`/`html`/`json-summary` reports CI publishes. |
| `npm run test:watch` | Watch mode for local iteration. |
| `npm run test:visual` | Storybook-driven visual regression snapshots. |
| `npm run test:e2e` | Playwright end-to-end tests. |
| `npm run e2e:matrix` | Playwright cross-browser matrix across Chromium, Firefox, and WebKit. |
| `npm run e2e:chromium` | Run E2E tests specifically against Chromium engine. |
| `npm run e2e:firefox` | Run E2E tests specifically against Firefox engine. |
| `npm run e2e:webkit` | Run E2E tests specifically against WebKit engine. |

### Cross-Browser End-to-End Matrix
The E2E test runner is configured with projects for **Chromium** (`Desktop Chrome`), **Firefox** (`Desktop Firefox`), and **WebKit** (`Desktop Safari`) in `frontend/playwright.config.ts`. Tests run with `fullyParallel: true` to optimize test execution time. CI executes `npm run e2e:matrix` and generates per-engine HTML and JSON reports under `frontend/playwright-report/`.

Responsive screenshots run with `npx playwright test --project=responsive-375
--project=responsive-768 --project=responsive-1440`. They cover the landing,
dashboard, and analytics routes at 375, 768, and 1440 pixels. To approve an
intentional layout change, run the same command with `--update-snapshots`,
review the generated files under `frontend/e2e/responsive-screenshots.spec.ts`
snapshot directories, and commit the updated baselines with the code change.

## Accessibility checks

### Component-level checks
Component tests use `axe-core` through `vitest-axe`. New components should test
each meaningful state, including error, loading, empty, and interactive states,
and assert `toHaveNoViolations()` against the rendered container. A violation
fails the Vitest suite and must be fixed or intentionally excluded with a
documented reason.

### End-to-end checks (Playwright)
End-to-end accessibility tests (`frontend/e2e/accessibility.spec.ts`) scan complete
pages and real user flows using `axe-core` in headless Chromium. Unlike component unit
tests, E2E accessibility checks catch page-level problems such as document landmark
structure (`<main>`, `<header>`, `<footer>`), heading hierarchy, color contrast in
real rendered layouts, and accessible names during live navigation.

All main routes (`/`, `/docs`, `/app`, `/app/onboarding`, `/app/owners`, `/app/recurring`,
`/app/analytics`, `/app/history`, `/app/settings`) are checked against WCAG 2.1 Level AA
rules (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`). Any new accessibility violation fails
the E2E run and must be resolved before merging.

Coverage is configured in [`vitest.config.ts`](../vitest.config.ts) and is
collected with `@vitest/coverage-v8`.

## Coverage policy

### What is measured

`coverage.all` is enabled, so **every** file under `src/` is reported — a module
with no test at all appears at 0% instead of being silently omitted. That is what
makes untested paths, especially error handling, visible.

The following are excluded because they carry no testable behaviour:

- `src/main.tsx`, `src/vite-env.d.ts`, and any `*.d.ts`
- `src/types/**` — type declarations only
- `src/**/*.stories.{ts,tsx}` and `src/visual/**` — covered by the Storybook
  visual-regression workflow, not this suite
- `src/test/**` — test infrastructure; [`harness.test.ts`](../src/test/harness.test.ts)
  covers it directly, so counting it here would double-count
- test files themselves

### How thresholds are set

Thresholds are a **ratchet**, not a target. Each number is recorded against the
measured value at the time the policy landed, and may only ever move upward —
and only in a pull request that raises real coverage to match. They exist to
make regressions fail loudly, not to define "enough" coverage.

Measured when the policy was introduced (statements/branches/functions/lines, %):

| Area | Statements | Branches | Functions | Lines | Enforced floor (l/f/s/b) |
| --- | --- | --- | --- | --- | --- |
| Global | 51.2 | 70.4 | 57.2 | 51.2 | 50 / 55 / 50 / 68 |
| `src/lib/**` | 53.8 | 72.0 | 56.0 | 53.8 | 52 / 54 / 52 / 70 |
| `src/hooks/**` | 42.5 | 83.0 | 70.0 | 42.5 | 40 / 68 / 40 / 80 |
| `src/components/**` | 63.3 | 65.5 | 59.1 | 63.3 | 60 / 57 / 60 / 62 |
| `src/pages/**` | 39.2 | 72.2 | 50.0 | 39.2 | 37 / 48 / 37 / 70 |

Areas are governed **individually**. Without per-area floors, a large gain in a
well-tested area can mask a regression in a weak one, which is exactly the drift
this policy exists to prevent.

### Raising a threshold

1. Write the tests that raise the number.
2. Run `npm run test:coverage` and read the printed summary, or open
   `coverage/index.html` for the per-file breakdown.
3. Update the floor in `vitest.config.ts` to the new measured value rounded
   **down** to a whole number, so small floating-point differences between
   environments cannot fail CI.
4. Update the table above in the same pull request, so the recorded baseline
   stays truthful.

Never raise a floor without adding the tests that justify it — the build will
pass either way, but the ratchet is only meaningful if it moves with real work.

### When coverage fails

A failure prints which threshold was missed, for example:

```
ERROR: Coverage for lines (48.12%) does not meet "src/hooks/**" threshold (50%)
```

Open `coverage/index.html` and sort by ascending coverage to find the files
regressing the area. Error paths that are never exercised are the usual cause —
prefer testing them over widening the floor.

## Simulating contract calls

Hook and component tests must not invent their own contract stubs; ad-hoc mocks
drift from the real contract and from each other. Use the shared harness in
[`src/test/harness.ts`](../src/test/harness.ts):

```ts
import { vi } from "vitest";
import { applyContractHarness, installContractCallHarness } from "../../test/harness";

vi.mock("../../lib/contract", (importOriginal) => applyContractHarness(importOriginal));
vi.mock("../../lib/submit", (importOriginal) => applyContractHarness(importOriginal));

const contract = installContractCallHarness();

beforeEach(() => contract.reset());
```

`applyContractHarness` replaces only the I/O surface and leaves pure helpers
(`mapProposal`, `canonicalEventKey`, …) real, via `importOriginal`. Responses
come from [`src/test/contractFixtures.ts`](../src/test/contractFixtures.ts),
which mirrors what `lib/contract.ts` returns after decoding a simulation — so
every test sees the same shapes.

The harness supports the three situations a test needs:

```ts
contract.setMode("failure");            // every call rejects
contract.setMode("slow");               // every call is delayed (~250ms)
contract.setFailure(new Error("..."));  // reject with a specific error
contract.setLatency(50);                // explicit latency
contract.set("getProposal", {...});     // override one read
contract.setWriteFailure(new Error("..")); // writes reject
```

`harness.test.ts` guards against drift: it fails when `lib/contract.ts` or
`lib/submit.ts` gains an export that the harness does not classify as a
simulated read/write or list as a pure helper. Adding a contract call therefore
means updating the harness in the same pull request.

# Storybook & visual regression

The Accord frontend uses [Storybook 10](https://storybook.js.org/) with the existing Vite + Tailwind stack. Component stories live next to components under `src/components/**/*.stories.tsx`.

## Local development

From `frontend/`:

```bash
npm run storybook
```

Storybook serves at [http://localhost:6006](http://localhost:6006). Stories use the dark zinc theme via the global preview decorator (`MemoryRouter` + `dark` class).

Build a static Storybook bundle:

```bash
npm run build-storybook
```

Output is written to `frontend/storybook-static/`.

## Visual regression snapshots

DOM snapshots are generated from Storybook CSF stories in:

- `src/visual/componentStories.visual.test.tsx`
- Baselines: `src/visual/__snapshots__/`

Run the visual suite:

```bash
npm run test:visual
```

### Updating snapshots intentionally

After an intentional UI change, refresh baselines:

```bash
npm run test:visual -- -u
```

Review the diff in `src/visual/__snapshots__/` before committing.

## CI

The workflow `.github/workflows/frontend-storybook.yml` runs on frontend changes:

1. `npm ci`
2. `npm run test:visual`
3. `npm run build-storybook`

## Notes

- Chart stories mock `ResponsiveContainer` in visual tests for stable snapshots.
- Contract and recurring-payment hooks are stubbed in Storybook (`.storybook/mocks/`) and in visual tests (`src/visual/mocks/`).
- Components that need routing are wrapped with `MemoryRouter` in preview and visual renders.

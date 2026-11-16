# Vendored: diagrammatic chart forms, commit 7d742765

This folder holds six chart forms of assistant-ui's `diagrammatic`, kept
unmodified inside madarch so the wiki can draw a treemap, a heatmap, a
sunburst, a bar, a stacked bar and a sparkline without installing a chart
library (task madarch-64o5.82; the owner's choice of 2026-11-15, compared with
six other libraries in `docs/explorations/kit-charts-choice.md`).

- **Source:** https://github.com/assistant-ui/assistant-ui —
  `packages/diagrammatic`, commit
  `7d7427653f6ba47b0b954510eed9c594d64e74d5` (`git log -1`: "chore: update
  versions (#10570)"), read on 2026-11-15. MIT licensed; `LICENSE` beside this
  file is that repository's, unmodified.
- **Why vendored, not a dependency:** the package is marked `private` in its
  own manifest and the build on npm is 0.0.4 of 2026-09-07, older than the
  sources here; vendoring pins what we read and keeps the wiki's build offline.
- **Included** (exactly what the six forms import, nothing else — the whole
  import closure, 14 files, 90 KB): `src/core/` (`geometry`, `layout`, `scale`,
  `text`, `theme`, `types`), `src/react/svg.tsx`, `src/react/motion.tsx`, and
  the six forms in `src/react/charts/` — `treemap`, `heatmap`, `sunburst`,
  `bar`, `stacked-bar`, `sparkline`.
- **Unmodified:** every file here is byte-identical to the source above
  (verified by hash after copying). Their imports are relative, so the folder
  layout is kept as it is; nothing in them names madarch.
- **Theming:** the forms read CSS custom properties — `--dg-c1`…`--dg-c7`,
  `--dg-pos`, `--dg-neg`, `--dg-ink` (default `currentColor`), `--dg-muted`,
  `--dg-grid`, `--dg-surface`, `--dg-font` — falling back to their own defaults
  when unset. `wiki/app/src/styles/charts.css` sets every one of them from the
  kit's tokens, so a figure takes the page's palette, type and light/dark
  scheme; no chart carries a colour of its own.
- **Runtime:** React 18 or 19 as a peer, zero other dependencies. Every form is
  a pure function of its props that returns SVG, so it draws through
  `react-dom/server` as well as in the browser, and it needs no measurement.
- **Updating:** copy the same files from a newer commit, keep them
  byte-identical, update the commit here, and run the wiki app's checks and the
  kit page.

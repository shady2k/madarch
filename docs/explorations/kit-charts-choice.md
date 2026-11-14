# Charts and kit primitives for the wiki — madarch-64o5.82

Status: proposal. The owner decides which library enters the kit; nothing is
vendored or installed before that. Task: madarch-64o5.82, stage 1.

## What is being chosen, and what it must satisfy

The kit page is the whole kit (decision 0020): a component enters it only with
the owner's approval. The owner's question of 2026-11-15 was whether
assistant-ui's chart packages belong in the kit, and whether the components the
kit made itself should be replaced. This note compares the packages that could
draw what we need, before anything is vendored.

Three needs:

1. **Charts and hierarchy** — treemap with an area and a colour switch over a
   drillable hierarchy, sunburst, bar, stacked bar, a matrix heatmap, a
   sparkline.
2. **An activity calendar** — the GitHub-style contribution graph over a
   repository's history.
3. **Primitives to compare our own kit components against** — the audit of
   `wiki/app/src/components/ui/*`, its output is `docs/explorations/kit-audit.md`.

Criteria, in the owner's order:

- permissive licence (MIT/Apache-2.0/ISC/BSD);
- works fully offline, no network and no CDN at build or run time;
- React 19 + Vite 8 (the wiki app is `react@19.3.0`, `vite@8.3.4`,
  `typescript@7.0.2`, Tailwind v4);
- SVG drawn from props, no browser measurement, so the same figure renders
  through `react-dom/server`, in a test, or in the page;
- themed by our CSS tokens (`wiki/app/src/styles/tokens.css`), light and dark
  from `prefers-color-scheme`, with no second palette in JavaScript;
- a treemap whose area and colour metrics can be switched and whose hierarchy
  can be drilled;
- accessibility;
- bundle size;
- maintenance: a release in the last six months, open issues.

## Method

Read on 2026-11-15 from primary sources: each project's repository (licence
file, package manifests, sources), its README, and its release list through the
GitHub REST API; sizes and dependency counts are the npm registry's metadata for
the current version, unpacked. Sizes are the whole published package, not the
part a page would ship. Where a claim rests on the sources rather than on a
statement, the file is named.

## Need 1: charts and hierarchy

| Library | Licence | Runtime deps | Size (unpacked) | Latest release | SVG from props | Themed by CSS tokens | Forms we need | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| diagrammatic (assistant-ui) | MIT | 0 | 2.5 MB (all 68 forms); the six we need import 14 files, 90 KB | 2026-11-13 (`assistant-ui@0.0.135`; package `private`, npm carries 0.0.4 of 2026-09-07) | Yes — pure functions, no hooks or browser APIs in the six forms' import closure | Yes — `--dg-c1`…`--dg-c7`, `--dg-pos/neg`, `--dg-ink` (defaults to `currentColor`), `--dg-muted/grid/surface/font` | Treemap, Sunburst, Heatmap (cell/dot/calendar), Bar, StackedBar, Sparkline | **Recommended** |
| unovis | Apache-2.0 | 0 in `@unovis/react`, `@unovis/ts` beside it | 231 KB (`@unovis/react`) | 2026-11-10 | Yes — has `@unovis/ssr` (charts to SVG in Node) | Partly — colours are config objects; CSS variables can be passed as strings, but each chart's palette is set in JS | Treemap, Sunburst, Heatmap, Bar, StackedBar, Sparkline | **Runner-up** |
| visx | MIT | 4–5 per package | 48 KB (`@visx/hierarchy`), 227 KB (`@visx/shape`) | 2026-06-11 | Yes — plain React SVG primitives | Yes — we write every attribute | Building blocks only: treemap/sunburst layout, heatmap, shapes; bar, stacked bar and sparkline are ours to draw | Viable, more of our code |
| d3-hierarchy (+ d3-shape) | ISC | 0 | 105 KB | 2026-11-03 | Yes — layout math only | Yes — we draw the SVG | Layout only | Our own fallback for a form no library draws |
| shadcn/ui charts (Recharts) | MIT | 11 | 7.5 MB | 2026-07-25 (Recharts 3.10.1) | Needs a browser to measure (`ResponsiveContainer`); a fixed size renders statically | No — colours are Recharts props (`fill`, `stroke`), each chart configured in JS | Treemap and Sunburst exist, as do bar, line and area; each is a client component configured in JS | Not taken |
| Nivo | MIT | 8–16 per package | 87–343 KB per package (`@nivo/treemap` 247 KB, `@nivo/bar` 343 KB) | 2025-05-23 | Some forms only ("a few provide server side rendering") | No — `theme` is a JavaScript object, a second palette by construction | Treemap, Sunburst, Heatmap, Bar, Calendar | Not taken |
| Observable Plot | ISC | 3 | 1.7 MB | 2026-11-05 | No — `src/plot.js` reaches `document` 13 times; needs a DOM on the server | No — colours are options | No treemap (its `tree` mark is node-link); bar, cell heatmap, line | Not taken |
| Apache ECharts | Apache-2.0 | 2 | 60.3 MB | 2026-05-19 | Yes, in SSR mode (`ssr: true`, verified in `src/core/echarts.ts`) | No — a JS theme object | Treemap, sunburst (with drill), heatmap, bar, sparkline | Not taken (size, JS palette) |
| Chart.js | MIT | 1 | 6.2 MB | 2026-10-22 | No — canvas only | No — JS colours | Bar, line; treemap and sunburst need plugins | Not taken (no SVG) |
| Tremor | Apache-2.0 | 7 | 494 KB | 2025-01-13 (repo pushed 2025-10-10) | Built on Recharts | No | Bar, line, area; no treemap | Not taken (Recharts, no release in 22 months) |

**Recommendation: diagrammatic.** It is the only candidate that meets every
criterion without a second palette or a second rendering model: MIT, zero
runtime dependencies, pure functions that take their data as props and draw SVG
(the six forms' import closure is 14 files and 90 KB — read, not estimated), and
a documented theming surface that *is* CSS custom properties, including an ink
default of `currentColor`. Its Heatmap also has a `calendar` mark, which covers
a static activity figure without a second library. Vendoring it, as the task
asks, keeps the pin explicit (upstream marks the package `private`; the npm
build is two months behind HEAD) and keeps the wiki's build offline.

**Runner-up: unovis.** Apache-2.0, active (1.8.1, 2026-11-10), and the only
other candidate with an official server-side SVG package. It loses on theming:
colour is a per-chart JavaScript option, so the kit's palette would be copied
into JS — the one thing the owner's criteria forbid.

**What no library gives us:** the treemap's area/colour switch and the drill
state are ours in every candidate — the form draws one subtree from `{value,
children}`; the switch chooses the metric we pass and the drill passes a child
as the root. That is composition, not a missing feature.

## Need 2: the activity calendar

| Library | Licence | Deps | Size | Latest release | Theming | Interaction | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heat-graph (assistant-ui) | MIT | 1 (`@radix-ui/react-popper`) | 90 KB | 0.0.26, 2026-10-22 | Headless by design: the host passes `colorScale`, so our tokens are the only palette | Yes — Radix-style composition, tooltip, month/day labels, legend | **Recommended** |
| diagrammatic `Heatmap mark="calendar"` | MIT | 0 | inside the 90 KB closure above | 2026-11-13 | `--dg-*` tokens | None — a static figure | **Recommended for static figures** |
| react-activity-calendar | MIT | 2 | 178 KB | 3.2.1, 2026-07-07 | Colour props | Own styling model; no Radix semantics | Fallback |
| cal-heatmap | MIT | 9 | 6.9 MB | 4.2.4, 2023-12-29 | Own CSS and colour scale | Yes | Not taken (last release 3 years ago) |
| react-calendar-heatmap | MIT | 2 | 147 KB | 1.10.0, 2025-02-23 (repo pushed same day) | Class names | Hover only | Not taken (stale) |
| @nivo/calendar | MIT | 12 | 292 KB | 0.99.0, 2025-05-23 | JS theme object | Yes | Not taken (second palette, weight) |

**Recommendation: both, for different jobs.** heat-graph where the calendar is
an interactive figure on a page (hover, keyboard, tooltip), because it is
headless — the palette is whatever `colorScale` the host passes — and it is
built the way our kit is (Radix primitives, composition). diagrammatic's
calendar mark where the figure must be static (a document image, a test, a
server-rendered page), because it is already vendored and draws with the same
`--dg-*` tokens. If the owner wants one library only, heat-graph is the one for
the history calendar and the static case falls back to it with the tooltip
omitted.

## Need 3: primitives to compare our kit against

| Library | Licence | Deps | Size | Latest release | What it would mean for us | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| shadcn/ui (Radix or Base UI flavour) | MIT | copied in, per component | per component | CLI `shadcn@4.23.0`, 2026-10-27 | The base decision 0020 already took: components copied into `components/ui`, Radix underneath, themed by our tokens | **Keep** |
| @assistant-ui/ui | MIT (agentbase) | workspace packages, `@base-ui/react` | not published (npm 404) | in the assistant-ui repo, 2026-11-13 | shadcn-shaped components served by their CLI registry; a source to mine per component, not an installable dependency | Mine, do not adopt |
| Radix Themes | MIT | 4 | 4.9 MB | 3.3.0, 2026-01-31 | An opinionated theme and palette over Radix primitives — a second palette, and our kit is already Radix-based | Not taken |
| Ark UI | MIT | 69 | 3.3 MB | `@ark-ui/react` 5.40.0, 2026-10-29 | State-machine primitives; adopting it replaces every control we have and restyles them | Not taken |
| React Aria (components) | Apache-2.0 | 8 | 6.9 MB | 1.22.1, 2026-10-09 | Excellent accessibility, but its components are unstyled React Aria, so the kit is rewritten around its hooks | Not taken now |

**Recommendation: keep shadcn/ui on Radix** as the base, and take single
components from `@assistant-ui/ui`'s sources where the audit finds ours weaker
(its markdown and message parts matter for the chat task, not for stage 1).

## What this note does not decide

- Whether the kit vendors diagrammatic (recommended, pinned, offline) or takes
  the npm build of 0.0.4 (two months behind today's sources).
- Whether one library serves both needs or two do (diagrammatic for charts,
  heat-graph for the interactive calendar).
- Every replacement in `docs/explorations/kit-audit.md` waits for the owner's
  approval of that table.

## Checks run

`bun run check` on this branch, and the wiki app's own `bun run check` and
`bun test`, before the note was committed. No code changed in this commit.

## The kit page, as reviewed

The chosen forms stand in the kit page (the whole kit's list, decision 0020)
in their states — with data, empty, folded to a size budget, 390 px, and the
page's dark scheme — and the four shots below are that section of the page,
taken with headless Chromium (Chrome for Testing 157, viewport 1440 and 390,
`prefers-color-scheme` emulated) from a development page that mounts the kit
page alone.

- [1440 px, light](kit-shots/kit-charts-1440-light.png)
- [1440 px, dark](kit-shots/kit-charts-1440-dark.png)
- [390 px, light](kit-shots/kit-charts-390-light.png)
- [390 px, dark](kit-shots/kit-charts-390-dark.png)

Checked on the rendered page rather than by eye alone: every data state draws
an `svg[data-dg]` (the twelve figures), every empty state draws the kit's own
line instead (eight of them), the fills the browser computes are the token
colours — `rgb(46, 48, 52)` for the ink in light, `rgb(229, 229, 229)` in dark,
and the remaining steps are `color-mix` of that ink with the page — the
interactive calendar draws 376 cells with month labels, and the page has no
horizontal overflow at 390 px (`scrollWidth` equals the viewport).

## Two palettes for the figures (owner's decision, 2026-11-16)

The kit's chart ramp is one ink at descending strength — right for magnitude
and heat, wrong for categories: a treemap coloured by language, or a stacked
bar of published, failed and blocked, cannot be read when every mark is the
same grey. Both variants now stand side by side on the kit page
(`Chart palettes, side by side`), and the owner chooses.

- **One ink (default).** `--dg-c1`…`--dg-c7` are the text colour mixed towards
  the page in seven steps. Cost: nothing new — one palette, and light/dark come
  free from the tokens; but the smallest gap between two steps is ΔE 5.7
  (light) / 6.2 (dark), so neighbours are told apart only by strength, and
  readers with a colour-vision deficiency read the same thing everyone else
  does. This variant is what magnitude and heat keep, whichever way the owner
  chooses for categories.
- **Categorical.** Seven new tokens, `--chart-cat-1`…`--chart-cat-7`, in
  `styles/tokens.css` (the light set #3a92cb…#008671 and the dark set
  #a4d58d…#c69f4e, hues about 50° apart, chroma 0.12 and 0.11 — muted beside
  the graphite). A figure asks for it with `palette="categorical"`, and
  `styles/charts.css` maps the chart tokens onto those seven inside that scope,
  so there is still one source of colour and light/dark still come from the
  tokens. Cost: the only hue the kit carries, a second palette to keep, and
  seven colours that no single scheme can make perfectly separable under every
  deficiency.

**The check that was run.** The tokens were chosen and measured with
CIEDE2000 over sRGB, on simulated protanopia, deuteranopia and tritanopia
(Machado, Oliveira and Fernandes 2009, severity 1.0) and on WCAG 2.1 contrast
against the page (`#ffffff` light, `#292929` dark):

| Set | Worst pair, normal | protanopia | deuteranopia | tritanopia | Contrast vs page |
| --- | --- | --- | --- | --- | --- |
| One ink, light | 5.7 | 5.6 | 5.7 | 5.6 | 1.0–12.6 |
| One ink, dark | 6.2 | 6.2 | 6.2 | 6.2 | 1.1–12.6 |
| Categorical, light | 16.9 | 8.7 | 8.7 | 9.0 | 3.19–5.07 |
| Categorical, dark | 19.3 | 8.0 | 7.7 | 8.2 | 5.22–8.65 |

ΔE 2000 of about 2.3 is the just-noticeable difference, 5 is a clear one; both
sets clear it on the worst pair, the categorical one by more under normal
vision and about the same under a deficiency. What the table does not say:
under protanopia and deuteranopia seven categories compress into roughly five
usable steps, so the figures must keep their labels and legends as the primary
cue — the kit's forms print both. Contrast of every categorical mark is at
least 3.19:1 on its page, where the weakest step of the one-ink ramp
deliberately sits near the surface for low magnitude.

Shots: `kit-shots/kit-palettes-1440-light.png`, `…-1440-dark.png`, and the same
pair at 390.

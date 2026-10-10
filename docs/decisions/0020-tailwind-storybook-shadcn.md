# 0020. The wiki app's styling on Tailwind v4, its components from shadcn/ui, @tailwindcss/typography and lucide-react

Status: accepted
Date: 2026-10-10

## Context and problem
Decision 0018 made the wiki madarch's own thin app (React, built by Vite) and
madarch-iuc built its reading typography on hand-written stylesheets
(`wiki/app/src/styles/`). At the madarch-iuc checkpoint the owner decided
(~17:40 MSK, relayed through the coordinator's note) to move the styling to
Tailwind; ~17:55 he took shadcn/ui as well; ~18:10 he postponed Storybook and
added @tailwindcss/typography and lucide-react; ~18:45 he moved the restyle to
follow the mockup's look and structure closely. The wiki's tokens must stay
one place the editor of madarch-j0a shares.

## Decision
The owner's decision, recorded by the coordinator on madarch-iuc:

1. **Tailwind CSS v4 (4.3.3) with @tailwindcss/vite (4.3.3), CSS-first.** The
   theme is built from the existing tokens (`wiki/app/src/styles/tokens.css`)
   through `@theme`, so the tokens stay the single place and the editor of
   madarch-j0a reads the same values. The shell and the reading styles are
   rewritten in Tailwind utilities on that theme; the hand-written
   stylesheets leave.
2. **shadcn/ui, taken ~17:55.** Its components are copied into `wiki/app` by
   its CLI, themed from our tokens (neutral graphite, no brand colour, our
   Inter and JetBrains Mono faces), Radix primitives underneath. Used now for
   what the shell already has — the phone navigation drawer/sheet, the focus
   toggle button, tooltips on icon buttons; the rest of the set arrives when
   features need it. A fuller list of companion libraries may follow from the
   owner.
3. **@tailwindcss/typography** (pinned with Tailwind's version): as decided,
   the reading styles were to stand on its prose classes with our values on
   top (18 px body, 1.55 leading, the 36em column, the 40/36/32 heading
   ladder, graphite colours). As built (the restyle of 2026-10-10) they stand
   on our own element rules themed on the tokens instead, because every
   accepted value already pins the plugin's prose defaults; the plugin stays
   a dependency for the editor of madarch-j0a to take up. The owner's asked
   values all hold.
4. **lucide-react for every icon** (pinned): no other icon source and no
   Unicode symbols.
5. **The restyle is one task** (Tailwind + typography + the shadcn shell
   parts + lucide), from real product data only, keeping every measured value
   already accepted; the mockup (/tmp/madarch-run-iuc/mockup) is the look and
   structure reference the owner wants followed closely.
6. **Storybook is postponed** by the owner (~18:10): not added now; a
   deferred task under madarch-iuc holds it together with its accessibility
   addon and its screenshot comparison. The pre-migration revision is tagged
   `wiki-fallback-1` (local, not pushed) as the demo fallback.

## Why
The owner's words at the checkpoint ("Переделывай на tailwind сразу. Нужен
нам просмотр экранов, story…") and his 17:55 decision to take shadcn/ui.
Tailwind v4's CSS-first theme keeps a tokens file at the centre instead of a
config; shadcn/ui keeps components as madarch's own code (copied, not a
dependency) with Radix's behaviour underneath — the licence-safe, theme-able
way the owner chose; Storybook is the standard viewer for component states
and answers the "need to view screens" wish the walk's screenshots answered
only statically.

## Considered and not taken
- shadcn/ui was considered at 17:40 and undecided; the owner took it at 17:55.
- Other component libraries (Mantine, Chakra, Ark) were not put before the
  owner; none was asked for.

## Consequences
- madarch's wiki app depends on the Tailwind build (a Vite plugin) and on
  Radix's primitives; its own CSS carries almost none of its own rules.
- The tokens file is the source of the Tailwind theme: value changes flow to
  both the wiki and the editor (madarch-j0a).
- Storybook returns as a deferred task (its build would join CI then).
- A fallback point exists: the pre-migration revision is tagged
  `wiki-fallback-1` (local, not pushed) until the migration is accepted.

# The plugin sandbox is probed at start, and a machine that cannot confine asks its person once

Change: madarch-64o5.86
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.86, madarch-64o5.1
Kind: behavior

## Intent
Make the plugin sandbox work where the machine can give it one, and where it cannot, let this machine's person choose
once — in `madarch init` or, when no terminal answered, on the fill's preparation page — whether plugins run without
isolation. Never tell a person to set a variable or run a command.

## Rationale
The owner's decisions, 2026-11-15: «Нужно предложить запустить без песочницы без команд» and «Я не запрещал дополнять
установку». His NixOS-over-SSH walk failed every unit with a sandbox error even though the user manager delegated
cpu/memory/pids, because the daemon stood in the root-owned session scope, whose `cgroup.subtree_control` is empty; the
old `systemd-run --user --scope -p Delegate=yes` line left the daemon in the scope itself and did not give it a child
layout. The answer is this machine's and its person's, never the product's: «это не настройка продукта, это настройка
конкретного разработчика человека».

## Out of scope
- The product settings page and its separation into product and machine levels (madarch-64o5.111). This change puts the
  machine's answer beside the reading role, which is already the machine's setting on that page.
- A per-fill question after an answer was remembered; the fill page only states the answer in one line.
- A verified NixOS walk: this box has no `/nix/store`, so the whole-store bind and the systemd scope are implemented and
  unit-tested in their argument shape, but the NixOS path itself is not claimed as verified here.

## Changes to requirements
- product-wiki/plugin-isolation: add. A start probe, the delegated child layout, the one terminal question, the
  remembered machine answer, the preparation page's one question and its one-line note, and no user-facing variable.

## Preserved contracts
- product-wiki/pages: the preparation page remains a product template and its sections; the isolation question is one section state, not a second page (static)
- product-wiki/app: the page reads the existing `/api/settings` machine route and the existing settings file; no product setting, table or data file is added (static test)
- product-wiki/internationalization: every new word is in English and Russian (test)

## Coverage
- product-wiki/plugin-isolation: static test mutation review
- product-wiki/pages: static test mutation review
- product-wiki/app: static test mutation review
- product-wiki/internationalization: static test

## Where it is seen
Kind: request
Place: the preparation page at `/p/prepare?kinds=...`, and the machine settings section at `/p/settings`

1. On a machine without delegation, open the preparation page for a fill. One line names what the machine lacks and
   offers «Run without isolation» and «Do not fill».
2. Press «Run without isolation». The question goes; the page says plugins run without isolation and links to the
   settings. The next fill's preparation page does not ask again.
3. Open `/p/settings`: the machine section shows the same answer and can change it, apart from the product settings
   around it.

## Blocking questions
None.

## Design and decisions
`src/plugin/sandbox-probe.ts` probes the cgroup, user namespaces and a real no-op bubblewrap run, and caches one answer.
`src/plugin/sandbox-delegation.ts` starts the daemon through a transient delegated user scope when the user manager
delegates, then gives it a `daemon` child and a `plugins` sibling with cpu/memory/pids; `src/product/daemon.ts` wraps
the start and writes the daemon's real pid from the scope's shell. The answer lives in `<madarch home>/settings.json` as
`pluginsUnconfined`, through `src/knowledge/settings.ts`. `madarch init` asks once in a terminal; the preparation page
asks once when no terminal did, and otherwise states the answer. `fillIsolation` refuses a fill that has no answer where
confinement is impossible, and passes `unconfined` through the fill, plugin host, sandbox and repository inputs. The
NixOS fix binds `/nix/store` and `/run/current-system` whole read-only instead of every farm link, which also removes the
credstore bind error.

## Acceptance evidence
Static: `bun run check` passed on the branch (tsc, architecture, UI, catalog, workflows, quarantine); the app's own
`bun run check` passed.
Test: `test/sandbox-probe.test.ts` 6 passed (probe without delegation, delegated scope command, settings file, no
variable in the interface, terminal answer); the preparation and settings page cases pass; `test/plugin-host.test.ts`
13 passed, 34 skipped; `test/daemon-one-store.test.ts` passed; `wiki/app` 123 passed, 0 failed, and its own
`bun run check` passed.
Screenshots: the preparation page with the question and the machine settings section at 1440 and 390, light and dark,
were taken from a served product on this machine: `/tmp/t86-prepare-1440-light.png`, `-1440-dark.png`, `-390-light.png`,
`-390-dark.png`, and `/tmp/t86-settings-1440-light.png`, `-1440-dark.png`, `-390-light.png`, `-390-dark.png`. Each page's
text and bounding boxes were read: the question names no variable, the two buttons fit the column, and the page's scroll
width equals its viewport at both widths.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.
NixOS: the whole-store bind and the scope's argument shape are unit-tested; the actual NixOS walk is not verified here.

## DONE WHEN
A machine whose user manager delegates starts the daemon in a child layout with no command or setting from the person.
A machine that cannot confine asks once, in `madarch init` or on the preparation page, remembers the answer in the
machine's settings, shows and changes it there, and the fill page states it in one line. No user-facing text names the
operator variable.

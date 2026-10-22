# One press in the wiki fills the graph and lets a chosen agent write the product pages live, and madarch init leads a newcomer there

Change: madarch-m38l.3
Base: 48ba70c0de992d8b138bb77d1c2534ef62f92c54
Tasks: madarch-m38l.3
Kind: behavior

## Intent
The owner refused a first-vertical run made of engineer commands. A newcomer reaches the vertical (decision 0029) through madarch's own command and the wiki alone: `madarch init` in a code repository makes the product around it and prints how to open its wiki; in the empty wiki the reader chooses the agent once, presses one button, and watches the product page and then each domain page appear as the agent writes them. The wiki is never stopped or restarted: the writer of madarch-m38l.2 runs inside the product's background server, on the product's own open graph store, one unit after another.

## Out of scope
- Real agent runs: they need the owner's explicit yes with the agent and the cap; the tests drive a scripted agent and the fake ACP agent.
- Editing the written pages in the wiki, other page kinds, several code repositories in one agent stage (refused in words), and a stop button for a running stage.
- A new page for the agent in the documents app: only the knowledge wiki carries the stage.

## Rationale
The writer, the extract driver and the adapter install already exist. This change joins them: the knowledge product gains an agent choice file and an agent stage after the fill; the server gains two routes (`GET /api/k/agents`, `POST /api/k/agent`); the app gains the choice and the unit card. `madarch init` prints the newcomer steps, and the release binary build builds the wiki app when its dist is missing or stale, so a fresh binary carries the current app.

## Changes to requirements
- product-wiki/agent-stage (absent on the target): add. The choice, the bound stated in words, the single press as consent, the live pages and the per-unit progress. Complete proposed text in `capabilities/product-wiki.md`, with the scenarios `agent-choice-states-the-bound`, `one-press-flows-into-the-agent`, `page-appears-when-its-unit-writes-it`, `no-agent-without-a-press` and `refusal-is-shown`.

## Preserved contracts
- product-wiki/serve: the server, its routes and its change stream answer as before; the stage only adds status fields and two routes.
- product-wiki/acp-agent: the ACP client and the adapter install are used unchanged.

## Coverage
- product-wiki/serve: test
- product-wiki/acp-agent: test
- product-wiki/agent-stage: test

## Where it is seen

Kind: screen
Place: the wiki of a product made by `madarch init` in a clean products home, at its front door
Mockup: docs/prototypes/madarch-m38l.3/writing-live.png

1. In a code repository the person runs `madarch init` and reads where the product is, the address of its wiki (with the SSH tunnel line when remote) and the next steps.
2. They open the wiki: it is empty, offers Claude Code, Codex and no agent with the bound in words.
3. They choose an agent and press the one button; a progress bar reads the commits, then the card shows the product unit writing now and the home page fills in; the domain units follow, each page appearing as it is written.

## Blocking questions
None.

## Design and decisions
Decision 0029 and the vertical's shared formats. Choices inside them:
- The agent choice is a file in the product's store folder (`<products home>/.madarch/knowledge/<product id>/writer.json`), outside the product repository (a machine's choice, not product data); the press that starts the fill saves it, installing the adapter into madarch's agents folder first when it is not there.
- The agent stage runs after the code fill in the same asynchronous task that holds the fill's slot, so there is one run at a time, and `KnowledgeProduct` reuses its own `DatabaseOwner` and graph store: no second fill, no second open of the PGlite store.
- The writer's sink notifies the change stream when a page is written, not when the unit ends, so the home page is served as soon as the product unit writes it.
- The stage refuses a product with more than one code repository, naming them: a page written from one of several would be a silently smaller result.
- A server restart ends a running stage; the pages written stay on disk and the next press resumes the fill and rewrites the pages.

## Acceptance evidence
Run on the SkyPilot pod (`madarch-sky-test --avx2`) on 2026-10-22:
- `bun run check` (tsc) and wiki/app `bun run check`, `bun test` (263 pass, 0 fail) and `bun run build` exit 0.
- test/knowledge-agent.test.ts (9 cases, the training-free tiny fixture, the real fill and writer, a scripted agent): the choice and its refusals, the choice kept in the store folder, a fill with no agent runs none, a request from another site starts nothing, a press made for another agent is refused, concurrent choices, and the single press: the product page is served while the second unit is held open, the server answers meanwhile, and the open change stream is told.
- test/madarch-init-e2e.test.ts: a clean products home, the generated training repository, `madarch init` as a command, the address it prints, the choice of the agent, one press: the fill (about 8 minutes on the pod) flows into the fake ACP agent behind an adapter executable on the PATH (the production path), three units are written, and the home page and both domain pages are served with every ground resolved.
- The walk `bun scripts/knowledge-shots.ts --only agent` rendered the agent choice, a unit in progress (home page served, the other domains labelled "being written") and the home and a domain page after the write; the pictures were read and fixed: plural wording, an empty path in the skipped-files note (a `code.file` node with no path is no repository file and is no longer offered to the content ingest), broken-looking links to pages the agent had not yet written.
- A read-only review by Codex found seven defects, all fixed or answered: a cross-site request could start a fill or an adapter install (now refused by `Sec-Fetch-Site`), a unit could start after shutdown, a press could run an agent other than the one it was made for (the press names its agent), concurrent choices shared one temporary file, the writer read from a moving HEAD (now the fill's pinned commit), a hand-built wiki dist could be embedded in the binary (now rebuilt), and an interrupted partial run left no way back (the offer shows while no domain page exists).
- Known and not fixed here: a stage interrupted by a server restart leaves its written pages and an idle stage; a run with some but not all domain pages written shows no offer; the toolbar shows no agent unit count before the product page declares its domains; `madarch init` fails with git's own words when the machine has no git identity.

## DONE WHEN
A newcomer who runs `madarch init` in a code repository and opens the wiki it prints chooses an agent, presses one button, and watches the product page and the domain pages appear as the agent writes them, with the wiki answering throughout and no command, script or path of madarch's checkout typed.

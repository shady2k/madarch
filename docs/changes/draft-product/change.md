# Start a product from an idea: a draft product repository that opens as a wiki

Change: draft-product
Base: 1f7f1825c4ba85dc42c5f309d6c35cd308daf1a1
Tasks: madarch-rtr.1.1, madarch-rtr.1.2, madarch-rtr.1.3, madarch-rtr.1.4, madarch-rtr.1.5, madarch-rtr.1.6, madarch-rtr.2.1, madarch-rtr.2.2, madarch-rtr.2.3, madarch-rtr.2.4, madarch-rtr.2.6, madarch-rtr.2.7, madarch-rtr.2.8
Kind: behavior

## Intent
Today madarch reads repositories that already exist: a repository declares its
intended model, madarch compiles it and builds a static wiki from it. Nothing
lets a person with only an idea start: there is no product repository to hold
the idea, and no wiki that follows the files as they are written. After this
change `madarch new` creates a draft product repository — a real git
repository holding the product's constitution, its manifest and its folders —
and a local madarch serves that product's wiki, read from the working tree,
and opens it in the browser; a Markdown file saved under the product's `docs/`
becomes a page, and a page already open shows the new text by itself, with the
server still running. This is outcome 1 of the idea-to-wiki charter: the first
step of the milestone's walk, from an empty folder to a named product.

Stories:
- As a person with only an idea, I run `madarch new` and my draft's wiki opens
in the browser, naming the product and listing the pages it has.
- As the agent working in the product root, I write `docs/vision.md` and the
page appears; the reader who has that page open sees the new text within
seconds, without anyone restarting the server or reloading the page.
- As the person coming back the next day, I run `madarch serve` in the product
root and read the product as its files are now.

## Out of scope
- The model's pages and their diagram tabs (LikeC4, Mermaid, archify) in the
served app: a draft has no model, and the model's pages arrive with the work
that gives a product a model. The static export keeps them unchanged.
- Mermaid blocks inside a document of the served app (the static export draws
them): the served app shows a document as formatted text first.
- Writing from the wiki: the page editor, the chat, comments, sign-in and MCP
(decisions 0017 and 0018; the agent-access milestone).
- The contract a document is checked against on write and on commit: outcome 2
(madarch-fe1). `madarch new` installs no hook in the product repository.
- The product's open questions (outcome 3, madarch-0uc), prototypes
(outcome 4, madarch-ls3), naming the product, its remote and `madarch list`
(outcome 5, madarch-mni).
- Documents outside the product's `docs/` folder and its `README.md`; search;
translations; several products served by one server; publishing or hosting a
product's wiki.
- The model server's own command (`bun scripts/serve.ts --data FOLDER`),
which keeps its behaviour and its tests.

## Rationale
Decision 0017 (2026-10-09) makes one wiki per product the product's source of
truth and place of work, kept as Markdown in a product repository apart from
the product's code; decision 0018 makes that wiki madarch's own thin app over
its server, with Starlight and Zensical kept as the read-only export. The
milestone idea-to-wiki opens with the person who has only an idea, so its
first outcome creates the product and serves its wiki; the later outcomes fill
that wiki with intent, open questions, prototypes and a name.

## Changes to requirements
- product-repository (new capability): creating a draft product repository with its constitution, its manifest, its stable id and its own git history, and reading a product's identity from its manifest.
- product-wiki (new capability): the product's wiki — the pages its documents make, their live update as the files are saved, the command that serves the wiki and opens it, and madarch's own app that shows it.
- server/serves-wiki (new): a server started with a product folder serves that product's wiki, reading that one repository read-only to do it.
The rest of what the two proposals move is not a requirement delta: the server's Purpose, its security and operation quality requirements and its coverage limits, and the glossary's entry for the wiki.

## Preserved contracts
- intended-model/schema: unchanged; the intended model's format does not move.
- intended-model/files: unchanged; a product's documents are not the intended model.
- compiled-model/shape: unchanged; no compiled model is read or written by this change.
- model-history/store-version: unchanged; nothing is sent to or stored by the server.
- graph-queries/view: unchanged; no query is asked differently and no engine changes.
- views/view-set: unchanged; the renderer and the view set are untouched.
- model-check/compiles: unchanged; the model check is not run on a product folder.
- model-authoring/skill: unchanged; the skill still writes a code repository's model.
- server/send: unchanged; the send command still runs the check first.
- server/store: unchanged; the graph is still built only from the models sent to the server.
- server/view: unchanged; a view is answered from a sent source's graph, at the current time and the first state.
- server/explains: unchanged; a request that cannot be answered still says why and names what is accepted.
- server/sources: unchanged; what the server holds is listed as before.
- server/survives-restart: unchanged; stored histories answer the same after a restart.
- server/identities: unchanged; source ids are unaffected by a product folder.
- server/immutability: unchanged; a resend is judged by its digest as before.
- server/protocol: unchanged; the wire protocol and the version it names are untouched.
- wiki/pages: unchanged; the static site's pages are built as before.
- wiki/diagrams: unchanged; the static site's diagram tabs stay.
- wiki/engine: unchanged; Zensical and Starlight still build the static site.
- wiki/documents: unchanged; the static site's documents section is untouched.
- wiki/links: unchanged; the static site's link check is untouched.
- wiki/result: unchanged; the wiki command's exit codes and messages are as before.

## Coverage
- product-repository/draft: test, draft-product
- product-repository/manifest: test
- product-wiki/pages: test, draft-product
- product-wiki/live: test, draft-product
- product-wiki/serve: test, draft-product
- product-wiki/app: test
- product-wiki/result: test
- server/serves-wiki: test
- server/store: test
- server/view: test
- server/explains: test
- server/sources: test
- intended-model/schema: test
- intended-model/files: test
- compiled-model/shape: test
- model-history/store-version: test
- graph-queries/view: test
- views/view-set: test
- model-check/compiles: test
- model-authoring/skill: test
- server/send: test
- server/survives-restart: test
- server/identities: test
- server/immutability: test
- server/protocol: test
- wiki/pages: test
- wiki/diagrams: test
- wiki/engine: test
- wiki/documents: test
- wiki/links: test
- wiki/result: test

## Blocking questions
None.

## Design and decisions

Decided with the owner before the run (2026-10-09, on madarch-rtr): the wiki
is madarch's own thin React app built by Vite, served by the local madarch
server, which owns every rule; CodeMirror, remark, Mermaid and MiniSearch are
off the shelf; the diagram tabs stay; Starlight and Zensical remain the
read-only export (decision 0018). A draft lives under the products home, is a
real git repository, and has a stable internal id from creation.

Chosen by the agent while planning this change:

- **The products home.** `~/madarch/products/` by default; `MADARCH_HOME`
  moves the madarch home and `--home` this one command. Tests and the walk
  point it at a scratch folder, so no test writes into a person's home
  (madarch-1xq's rule).
- **The manifest is how a product repository is recognised.** `workspace.yaml`
  carries the three fields that are never renamed — `schemaVersion`, `id`,
  `name` — and may carry the pinned version of the skill set; it grows by
  fields added beside them, so a reader ignores what it does not know and a
  manifest written by a later madarch still opens. The folder layout is fixed
  by the schema version, never read from the manifest: `docs/` for the wiki's
  documents, `model/` for the intended model, `skills/` for the team's own
  skills (never a copy of the skill set), `prototypes/` and an untracked
  `repos/`.
- **`AGENTS.md` is written once.** `madarch new` writes the constitution and
  never rewrites the file afterwards; the part madarch maintains later lives
  between its marker comments, so the skill set may add its own sections
  safely. Nothing madarch writes holds an absolute path to the product, and
  the documents' links are relative paths, so renaming the draft's folder in
  outcome 5 breaks none of them.
- **The wiki reads the documents and nothing else.** `docs/` and `README.md`
  alone: the skill set's tracker at the product's root, every other dot-folder
  and every other folder are neither pages nor read.
- **The draft's name.** `idea-YYYY-MM-DD`, of the day's date, from the local date, with
  `-2`, `-3` … when that day's names are taken. Naming the product is outcome
  5; the folder is renamed in place then, and the manifest's id does not
  change.
- **The id.** An opaque identifier given at creation
  (`crypto.randomUUID()`), written into `workspace.yaml`; nothing else in
  madarch may use the folder's name as the product's identity.
- **What the skeleton holds.** `AGENTS.md` (the constitution: what the
  repository is, what each folder is for, that documents are Markdown in git
  and that a local madarch serves the wiki), `CLAUDE.md` holding `@AGENTS.md`,
  `workspace.yaml` (`schemaVersion`, `id`, `name`), `.gitignore` ignoring
  `repos/`, and the folders `docs/`, `model/`, `skills/`, `prototypes/` each
  kept by a `.gitkeep`. `docs/` starts empty: the vision, the hypotheses and
  the sources are outcome 2's work, not the draft's.
- **The app.** React built by Vite, kept in `wiki/app/` beside the Starlight
  template, with its own `package.json`, lockfile and build, so madarch's own
  dependencies and lockfile stay untouched. Markdown is rendered by
  `react-markdown` (remark inside it, no raw HTML), which keeps the app free
  of an HTML-injection step. The built files live in `wiki/app/dist/`, are
  ignored by git, and are built on first use by the command that serves them;
  a build the person cannot wait for is the reason for the cache, and the
  build is named before it starts.
- **The app's files are served by the server, not by a second server.** One
  address answers the app, its files and the wiki's API, so nothing has to be
  configured and no port is guessed. Unknown paths under the app's routes
  answer `index.html`, so a page's address can be opened, linked and reloaded.
- **A page's address** is `/p/` plus its path within the product, for example
  `/p/docs/vision.md`; the app's routes and the API (`/api/…`) never collide
  with a document's path.
- **The API** (rendered by madarch, read by the app): `GET /api/product` —
  the product's id and name; `GET /api/pages` — the pages with their paths and
  titles in code point order and the wiki's revision; `GET /api/page?path=…` —
  one page's path, title and Markdown. Every refusal is JSON with a message,
  as the server's other refusals are, and one line per request is logged with
  no document content.
- **The revision and the live update.** The revision is a digest of the pages'
  paths and contents, so the same working tree gives the same revision. The
  app asks for the pages once a second and refetches the open page and the
  list when the revision changes. A second, not a stream: the client is one
  browser on one machine, an always-open connection is a thing to keep alive
  and to test, and the same behaviour then holds for every page including the
  ones the app did not fetch. The bound the requirement states is two seconds,
  which the polling leaves room for.
- **What is a page, and what a link does.** Every Markdown file under `docs/`
  and `README.md` at the root; a link to a path the wiki does not hold is shown
  as its text, so no reader lands on a page that cannot be shown (the rule the
  static export uses where there is no host to link to).
- **The command surface.** `madarch` with the subcommands `new` and `serve`;
  `scripts/madarch.ts` is the entry, `package.json`'s `bin` makes `madarch` a
  command after `bun link` in a checkout, and `bun scripts/madarch.ts ARGS`
  is the same command without linking. `madarch serve` without `--product`
  serves the product of the current folder, which is where the agent runs.
- **Exit codes.** 0 for a draft created or a wiki served until it is stopped;
  2 when an argument, the products home, an address, a product folder, a
  manifest or the app's build cannot be used, each naming what is wrong; 1
  when git or the app's builder fails.
- **The browser.** Opened through the machine's own opener (`xdg-open`,
  `open`), injected in tests so no test launches a browser; an opener that
  fails is a warning and the address, never the command's failure.

Owner's settings for this run, recorded on madarch-rtr (2026-10-09): the
coordinator does not implement; workers are prime-agent sessions on
`glm-5.3-flash` in their own worktrees, one task each; reviews and
consultations go to `gpt-6.1-sol` through the Codex CLI; mutation testing past
the ten-minute budget is accepted only by the owner.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stages'
acceptance records, with the walk's numbers.

## DONE WHEN
After `madarch new` the draft's wiki opens in the browser, and a file the agent
saves under `docs/` changes its page without a restart. Where it is seen: the
address the command prints, opened in the browser on the draft's home page and
on the page of `docs/vision.md`; the file is written while the server runs, and
the open page shows its new text within two seconds.

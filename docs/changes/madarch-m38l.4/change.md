# The owner's remarks from walking the first vertical on madarch 0.2.0 are fixed: the root opens a product, more agents, a quick wiki during a fill, documents inside the knowledge shell

Change: madarch-m38l.4
Base: dfdaba6612be29db7e6b779ee8a86a1692478f8d
Tasks: madarch-m38l.4
Kind: behavior

## Intent
The owner walks the vertical (decision 0029) on madarch 0.2.0 and reports what is wrong; each remark is one commit. (1) The products home's root opens a product's wiki and shows no list of products: the product is chosen only in the selector at the top left. (2) The agent choice offers OpenCode, Pi and omp beside Claude Code and Codex, each driven over ACP and installed on the reader's yes. (3) A page answers within 300 ms during a fill: the fill and the writer's non-agent work leave the request path; the navigation shows the kind names in the reader's language, the kind page shows the human kind name and the Files list shows its files. (4) The sidebar's Documents entry is inside the knowledge shell, and a document ground opens its page at its anchor. (5) The product's pages are written in the product's content language, a manifest setting chosen on the agent card before the press with the interface language as the default and told to the agent in the writer's prompts. (6) The home page and the sidebar use the whole window height, and the navigation counts follow the pages as they appear. (7) By the owner's ruling ("we need no old app; we have one app") the old documents app, its shell, its routes and its API endpoints nothing else uses are removed: a product without a kinds manifest gets the starter manifest and templates, and a broken manifest is shown by the knowledge wiki as a page naming each finding with file and line.

## Out of scope
- Real agent runs: they need the owner's explicit yes with the agent and the cap; tests drive the fake ACP agent.
- A stop button for a running fill.
- The CLI's and the fill's own needs: what they still read of the old app's engine stays.

## Rationale
The remarks come from one walk; their causes are separate, so each has its own commit and its own evidence (see the task's comments). The fill's move off the request path is the one structural change; its design is in the commit that makes it.

## Changes to requirements
- product-wiki/one-app (absent on the target): add. One app; the root opens a product; the starter manifest or a findings page stands in for the old app. Complete proposed text in `capabilities/product-wiki.md`.
- product-wiki/documents (absent): add. Documents are pages of the knowledge wiki.
- product-wiki/responsive-during-fill (absent): add. 300 ms during a fill; localized kind names.
- product-wiki/content-language (absent): add. The product's content language is a manifest setting, set on the agent card, told to the writer; a page in another language is not refused.
- product-wiki/agent-stage (absent on the target): add, with OpenCode, Pi and omp beside Claude Code and Codex.
- product-wiki/pages, overview, shell, front-matter, architecture, repositories, stages, questions-and-overview, empty-home-guidance, discussions: removed with the old app; the knowledge wiki's pages and the documents requirement replace what a reader used.

### Inventory of the old app

1. pages: home listing docs/*.md + README, one page per Markdown file at /p/<path>, links between pages. -> (b) Documents list and rendered pages, now also covering connected repositories' Markdown. The `/p/` address is replaced by a knowledge-wiki address.
2. overview: product home with audience, problem, outcome, current milestone/state/next step read from manifest source mappings. -> (a) in spirit: the knowledge home is docs/product.md written by the agent (what it is, domains, grounded). The manifest `overview` mappings and milestone/state/next-step facts are (c). Would return under 0029 as a "product" or "milestone" kind in the manifest rendered by a template.
3. shell: left nav by document kind, `/g/` group pages, breadcrumb, language menu, focus mode, phone menu, brand link. -> (a) knowledge shell has nav, selector, language; kind pages replace `/g/` group pages. Focus mode and the breadcrumb are (c) (cosmetic); phone menu exists in knowledge shell if its NavPanel is used (to verify in screenshots).
4. front-matter: a page shows its set kind, fields block (id, status, dates, people), "grew from" links, "Linked from" backlinks, the set's check findings. -> (c). Returns under 0029 as kinds (requirement, use case, decision) with attributes and relations in the manifest and backlinks from the graph; the "set's check" findings would be a template/finding block, not today's.
5. architecture: Architecture section from model files and repos' madarch/ models: view pages with Mermaid + LikeC4 diagrams, element pages with relations. -> (c). The biggest loss. Returns as component/diagram kinds and templates (0029: "diagrams are a way to show graph data"); not built by this task.
6. repositories: /r section, one row per declared repo with url, branch, checkout state, last commit. -> (c) as a list; the files and symbols of a checked-out repo are reachable through the kind pages and source pages (a). Returns as a "repository" kind.
7. stages: stage list and expectations from the registry, completeness.json findings, tracker task groups. -> (c). Returns as a stage kind in the manifest if the product wants it; completeness findings would be a block over the snapshot.
8. questions-and-overview: question forms per kind from docs/kinds.yaml, overview mappings. -> (c) (old docs/kinds.yaml registry is not the knowledge madarch/kinds.yaml). Returns as an "open question" kind.
9. empty-home-guidance: getting-started text offering `madarch demo`. -> (a) the knowledge wiki's empty state (what to do, agent choice, one press); the `madarch demo` offer is (c) (the product is made by `madarch init`).
10. discussions: select text, comment, threads under comments/<ULID>/ with hidden markers, replies, resolve. -> (c). 0029 says people edit the source entity and an agent rewrites the text, so inline text comments are unlikely to return as they were; a comment on an entity could come back as a kind.

Also dropped with the app: the stage/task/question graph pages of decision 0026 and `/api/product`, `/api/pages` family used only by the old shell (to be listed by the removal commit from the route table).

#### OpenCode ACP entry (checked 2026-10-23)
`opencode acp` ("start ACP (Agent Client Protocol) server"). Verified on this machine: opencode 1.19.0 answers initialize with protocolVersion 1, agentInfo OpenCode 1.19.0, authMethods opencode-login ("Run `opencode auth login`"), loadSession true. npm: `opencode-ai` 1.19.4 (modified 2026-10-22), bin `opencode`, tiny wrapper (dist.unpackedSize 7852 B) that pulls a platform binary package (opencode-linux-x64 etc., optionalDependencies at 1.19.4); installed size to be measured on the pod. Not in need of an adapter package. Pi: `pi-acp` 0.0.34 adapter over `pi --mode rpc` (needs pi >= 0.81.0). omp: `omp acp` bundled.

## Preserved contracts
- product-wiki/serve: the routes of the knowledge wiki keep their addresses and answers.
- product-wiki/acp-agent: the ACP client and the adapter install are used unchanged.

## Coverage
- product-wiki/one-app: test
- product-wiki/documents: test
- product-wiki/responsive-during-fill: test
- product-wiki/content-language: test
- product-wiki/agent-stage: test
- product-wiki/serve: test
- product-wiki/acp-agent: test
- product-wiki/pages: test
- product-wiki/overview: test
- product-wiki/shell: test
- product-wiki/front-matter: test
- product-wiki/architecture: test
- product-wiki/repositories: test
- product-wiki/stages: test
- product-wiki/questions-and-overview: test
- product-wiki/empty-home-guidance: test
- product-wiki/discussions: test

## Where it is seen

Kind: screen
Place: the wiki of a product on a products home, opened at the server's root address
Mockup: docs/prototypes/madarch-m38l.4/front-door.html

1. The person opens the server's address: the product's wiki opens at once, with no list of products; the product is chosen in the selector at the top left.
2. In the empty wiki the agent choice offers Claude Code, Codex, OpenCode, Pi and omp.
3. During a fill every page answers at once; the navigation names (Domains, Services, Files, Symbols) read in the interface language, the kind page shows the kind's name, and the Files list shows the files its count names.
4. The sidebar's Documents opens the product's Markdown documents as pages of the same wiki.

## Blocking questions
None.

## Acceptance evidence
Recorded below as the remarks land.

## DONE WHEN
Each remark the owner made is fixed, seen on screenshots rendered the way a reader sees them, and the owner confirms on his walk.

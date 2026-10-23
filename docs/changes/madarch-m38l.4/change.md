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
The remarks come from one walk; their causes are separate, so each has its own commit where the code allows it, and its own evidence (see the task's comments and the acceptance evidence below). The structural change is the fill's: PGlite runs a statement on the thread that owns it and a commit of the fill is seconds of statements (measured on the pod: 89 % of the fill's 471 s was the graph's publication, and the event loop was blocked for 466 s of it), so a fill in the server's process starves every request. The fill is now a process of its own (`madarch knowledge-fill-worker`) that owns the primary store and makes a snapshot of it between commits; the server reads a snapshot through a read process of its own (`madarch knowledge-read-worker`), started for each new snapshot, so neither the fill nor the opening of a snapshot holds up the server's thread. The agent still runs in the server: the worker asks it for each unit and answers the unit's tool calls over the pipe.

Remarks 7 to 12, made on the same walk after the approval and covered by the approved requirements `responsive-during-fill`, `documents`, `content-language` and `one-app`:
- 7: the "pages written" card goes when the run is done; its outcome is a quiet status in the top bar that opens the units of the last run. A failure stays until it is dismissed.
- 8: the top bar's status opens "Refresh": the code is read again from the new commits and the pages' links are checked again. The agent writes only the pages that do not exist yet, or every page when the language of the pages is changed in the same menu. The incremental update of the agent's pages (edit only the pages whose grounds changed) is madarch-m38l.7; the seam is `unitsNeeded` in `src/writer/run.ts`.
- 9: the code is colored with Shiki (a light and a dark theme, TypeScript, JavaScript, Go, SQL, proto, YAML, JSON, Markdown, Dockerfile and more), loaded when a page first shows code.
- 10: while a page's data loads, a skeleton of the page stands where it will be.
- 11: the problems box says in plain words what a finding means and who puts it right; the file and line are behind "Details for an engineer". The cause of the finding the owner saw is fixed in the writer and the wiki (one reading of a document's sections).
- 12: the product menu offers "Start over...", with the same words as `madarch reset <product>`; `madarch upgrade` and a binary of another version starting end the running background server of the old version and start their own, saying so.

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

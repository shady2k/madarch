# 0017. The product wiki is the source of truth and the place of work, kept in git

Status: accepted; refined by 0019
Date: 2026-10-09

Partly supersedes 0016: its per-repository contract file installed by the skill
set, and the wiki built read-only inside each code repository.

## Context and problem
Decision 0016 made madarch the product's knowledge base, with documents kept in
each code repository, checked by a contract file the skill set installs, and a
wiki generated from them for reading. Walking what comes next, the owner set a
wider goal: one wiki that everyone in the company works in (product managers
form hypotheses, analysts write analysis, product engineers write use cases),
agent-first (an agent reads, writes, comments, answers comments, brainstorms
with a product manager, writes a use case with an engineer), federated across
products and later across the company, and from which the work itself is
launched. A read-only site built from scattered repositories cannot be that.

## Considered options
1. Keep 0016: documents in each code repository, a contract file per
   repository, a read-only wiki.
2. Move everything into the skill set and keep only a server in madarch.
3. The wiki as each product's source of truth, kept as Markdown in git in one
   product repository, written by people and agents through madarch, which is
   the same program locally and centrally.
4. The wiki's own database as the source of truth, git only for code.

## Decision
Option 3, decided by the owner in conversation on 2026-10-09.

- **One product repository per product**, separate from its code repositories
  even when there is one: the wiki, the work (hypotheses, outcomes,
  requirements, use cases, features, stages and tasks), a manifest of the
  product's code repositories and the team's skills and agent instructions.
  Cloning it and running its bootstrap prepares the whole workspace: the code
  repositories checked out by the manifest, the skills, and a local madarch.
  Kept apart for access, by the owner on 2026-10-09: nearly everyone may write
  to the product repository, while write access to code stays narrow; a
  combined repository would also put wiki edits behind the code's protected
  branch and CI, and a product that grows a second repository would have to
  move its knowledge out.
- **Markdown and YAML in git are the truth.** Nothing madarch keeps is more
  authoritative than git.
- **One write path.** People edit in the wiki, agents through madarch's MCP;
  both go through madarch, which runs the form check the skill set installed
  and refuses an invalid document, then commits it as its author (0019: the
  forms, templates and their check are the set's). Comments and discussions are kept in git
  beside their page.
- **A chat beside every page** (owner, 2026-10-09). The person writes what
  they want and an agent applies it at once, knowing the page and the graph
  around it, through the same write path; each change is its own commit, so
  undoing it is one action, and nothing waits for a confirmation. The agent
  runs on the madarch server, locally and centrally alike, with the skill
  set's behaviour (brainstorming, writing a use case, answering comments) and
  a model key of the organisation's; a person who prefers their own agent
  connects it through MCP or a REST API, by the same write path.
- **One tracker per product, in the product repository** (owner,
  2026-10-09). Until madarch serves work itself, it is beads_rust at the
  product root, which the skill set already drives; code repositories keep no
  tracker of their own, and their commits name the product's tasks
  (`Task: <id>`), resolved against the product repository's tracker. Whether
  tasks later stay in beads behind an adapter or become wiki pages is decided
  with the work launched from the wiki. An external tracker such as Jira is
  another adapter: first a link and its status shown on the page, then a
  two-way sync for teams that work there, with one system of record for each
  item and each field.
- **The work is launched from the wiki.** A run knows from the start which task,
  use case and requirement it implements, so the link from a requirement to its
  code is written while the work is done; the code index then checks for drift
  (code changed outside the wiki's work) rather than inferring the links.
- **madarch is the same locally and centrally.** It builds the graph from git
  and keeps it in LadybugDB: persistent, holding history and the links between
  products, derived and rebuildable from git. A local madarch serves a workspace;
  the central one serves the company.
- **Synchronisation is git.** A workspace pulls and pushes its product
  repository; servers are never merged into one another.
- **Federation:** the central madarch reads every product repository it is
  given and links products where their contracts meet (0003). Abstractions
  shared by several products live in a company-level repository of their own,
  later.
- **The skill set keeps the agents' behaviour** (how to brainstorm, write a
  use case, run and accept work) and reaches documents and work through madarch
  as its tracker and store.

## Consequences
- The vision is reworked; the knowledge-base milestone is closed early with
  outcome 2 (madarch-hnq) accepted, and the next milestone is chartered for this
  direction.
- 0016's contract file installed by setup is dropped: madarch-o3b is stopped in
  its form, and shady2k-skills skills-k8c narrows to moving the model-writing
  skill and to working through madarch.
- madarch's own documents move to a product repository of madarch's.
- The wiki needs an engine that writes; which one is open (research of
  2026-10-09). Also open: permissions, concurrent edits of one page, and how
  the skill set's tracker adapter speaks to madarch; what the server's agent
  may do on a person's behalf, and how its model spending is counted.
- Revisit if editing through git commits proves too slow or too coarse for
  people working together on one page at once.

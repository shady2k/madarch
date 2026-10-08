# madarch vision

madarch keeps a product's knowledge as a graph: what people intend (its
vision, requirements, use cases, decisions and architecture), joined with what
madarch finds in its code, configuration and deployments, across every
repository the product spans. The graph is the product; the wiki, diagrams and
answers to agents are views of it. A reader goes from the product's purpose
down to the line of code that implements one step of one use case, and every
claim on the way names its evidence.

## Audience

Everyone who has to understand the product, each from their own side of the
same graph:

- **Owners and product owners**: what the product is for, where it is going,
  what is built and what is not, by evidence rather than by report.
- **Analysts**: use cases, user stories and requirements, traced to the parts
  and code that realise them.
- **Product engineers and designers**: what a change touches, which use cases
  and requirements it serves, and what it breaks elsewhere before it merges.
- **Architects** of systems spanning many services and repositories, who need
  to see and explain how the parts interact.
- **Security, privacy and compliance engineers**: which data entities flow
  where, with what classification (personal data, commercial secret,
  communications secrecy), across which zones, on what grounds.
- **DevOps, DevSecOps and on-call engineers**: environments, stands,
  environment variables, external integrations, and what depends on what
  when something fails.
- **Testers**: the scenarios to check and the requirements they prove.
- **Newcomers and external integrators**: the product from the top, then only
  the part they need.
- **AI agents** working on the product, which need its knowledge as data they
  can query, not as pictures or as twenty repositories to read.

Early adopters: teams already practising docs and architecture as code
(Structurizr, C4, LikeC4, arc42) who have outgrown a single diagram and a
folder of documents nobody can trace.

## Non-users

- Teams whose product, the inside of its services included, fits in one
  readable diagram and one README.
- Anyone looking for a drawing tool. madarch computes views; it does not offer
  a canvas to arrange boxes by hand.
- Anyone looking for a wiki editor. Documents are written in the repositories,
  beside the code; the wiki is a view and is never edited in place.

## Problem

- **Product knowledge is scattered and cannot be traced.** The vision lives in
  one place, requirements in another, decisions in a wiki or in people's
  memory, and nothing says which code realises which requirement or use case.
- **C4 levels are fixed.** Context, containers, components and code leave no
  place for grouping by domain, zone or product, so a large system's context
  diagram becomes a tangle of arrows that shows nothing.
- **Layout is manual work.** Moving boxes so that arrows do not cross is hours
  per diagram and is lost at the next change.
- **Interactions are invisible in code.** A topic name, a host or a port usually
  lives in an environment variable set by a deployment repository, not in the
  code of the service that uses it. No single repository shows who talks to
  whom.
- **Nobody knows where the data goes.** Which topic carries a session id or a
  user's name, and through which zones, is reconstructed by hand before every
  audit.
- **Documents and models drift.** A hand-kept model or document and the
  running system part ways, and nothing says where, or what is still missing.
- **History is lost.** Nobody can answer "what did the integration look like on
  the day of the incident" or "what did we believe then".
- **Agents cannot use diagrams.** An agent needs to ask "which use cases does
  this function serve" or "where does personal data end up" and get a chain
  with evidence, not a picture.

## Alternatives and difference

| Alternative | What it lacks here |
| --- | --- |
| Structurizr, C4-PlantUML, Mermaid C4 | Fixed levels, one repository, no evidence from code, no history, no requirements |
| LikeC4 | Good views and navigation, but its DSL is a diagram model: no facts, provenance, bitemporal history or cross-repository checks. madarch uses it as a frontend |
| Commercial tools (Ilograph, IcePanel and others) | Paid; closed data |
| Code-graph tools (codebase-memory-mcp, repowise, graphify) | They index what code does, not what was intended or why: no use cases, requirements, domains, zones or data classification, one repository at a time. madarch indexes code itself and joins it with intent |
| Requirements traceability (sphinx-needs, Doorstop) | Requirements linked to requirements and tests, not to the architecture or the code's evidence |
| Archi / ArchiMate | Manual layout and editing; no link to code |
| Wikis (Confluence and the like) | Hand-written, unchecked, and wrong a few months after they are written |

The difference: a **product corpus in git** under one versioned contract
(vision, requirements, use cases as scenarios over the model, data entities,
decisions, the intended model), **facts from madarch's own code index and
pluggable extractors**, joined by **normalized contract ids** across
repositories, kept **bitemporally**, checked against **rules** and against
what is still missing, and served to people and agents through replaceable
frontends.

## Key journeys

1. **Irina, an architect, explains the platform to a new team.** She opens the
   organisation's graph at the level of domains: six boxes and a few aggregated
   arrows. She drills into "Billing", then into "Payments", each view readable
   because relations collapse to the visible level. She opens one arrow and sees
   the interactions behind it, the data they carry and the evidence for each.
2. **Pavel changes the orders service.** His pull request stops publishing an
   event. Before merge, madarch reads the branch and reports that use case
   "Place an order" loses its step 4 and that two consumers in other
   repositories lose their provider.
3. **Olga, a security engineer, prepares for an audit.** She opens the data
   entity "session id": where it is created, where it is stored, which flows
   and topics carry it, which zones it crosses, the rule that allows each, and
   the file each link was found in; and how that differed at the date of the
   last audit.
4. **Anna joins the team of one service.** She opens the product's wiki: its
   vision, its use cases, then her service's place in them, its parts and the
   modules of its core. Each use case shows its steps as a sequence diagram
   down to the functions that run them, with file and line.
5. **Marta, an analyst, follows a requirement.** She opens requirement
   "installment payments": the use cases it belongs to, the services and
   interfaces that realise it, the code behind each step, and whether each step
   is built, by evidence. The open questions list what is still unknown and who
   can answer it.
6. **Sergey connects a ten-year-old repository.** The skill reads it, rebuilds
   the model and the scenarios from the code, maps the existing documents, and
   asks him what the code cannot tell: why a decision was taken, where its
   record is. The wiki shows what is complete and what is still open, per role.
7. **An agent investigates an incident.** It asks the graph what depends,
   transitively, on the event bus in production, which use cases that touches,
   and what it looked like at 14:00 yesterday, and gets a chain with evidence
   instead of reading twenty repositories.

## Outcome

- One knowledge base of a product across all its repositories: its vision,
  roadmap, status, requirements, use cases and user stories, decisions and
  glossary; its architecture, deployments, environments, external
  integrations and data entities; and its code, each linked to the others
  with backlinks, each fact with its source and its time.
- Use cases as scenarios over the model, so their sequence diagrams, data
  flows and status (planned, partly built, built, regressed) are computed from
  evidence, not written.
- A data catalogue: every data entity with its classification, where it is
  created, stored and consumed, and every flow that carries it.
- Open questions: what is missing before the picture is complete, who can
  answer, and how complete it is for each role.
- Checks: dangling cross-repository references, contracts without providers,
  rule violations, drift between intent and code, broken scenarios, the corpus
  against its contract.
- Two modes: local (one repository, an embedded graph, a wiki built in place, a
  local MCP for agents) and a server (a product of many repositories, its
  history and its portal).
- Answers for people and agents over HTTP and MCP; diagrams through frontend
  plugins (Mermaid for documents, LikeC4 for navigation, graph databases for
  ad-hoc queries).

## Success signal

A newcomer answers "what is this product for, how does a use case run through
it, and where is that in the code" from madarch without opening the
repositories; an architect answers "who talks to whom, carrying what, and since
when"; and a pull request that breaks a use case or another repository's
interaction is reported before merge. Counter-metric: the effort to keep the
corpus current must not grow with the number of repositories; if people stop
updating it, the product failed even if the wiki looks good.

## Exclusions

- A manual diagram editor, a canvas or a wiki editor.
- A proprietary query language; ad-hoc queries use Cypher through the query
  engine or an exported graph database.
- Storing secret values; only references to them.
- Writing the corpus: authoring (the model, use cases, data entities,
  onboarding a repository) is done by agent skills in the shady2k-skills set
  against madarch's versioned document contract (decision 0016); madarch checks,
  stores and serves it.
- In the current milestone: see its charter, `docs/milestones/knowledge-base.md`.

## Constraints and assumptions

Known:
- Deployed by organisations themselves, often in closed networks: one Docker
  image, no outbound calls at runtime; the local mode needs no server at all.
- Open source, public repository: every dependency must be redistributable.
- Products span many repositories on different git hosts; GitHub and GitLab are
  the first webhook sources.
- The document contract is installed into repositories as one dependency-free
  file with a version; the server accepts a range of versions.

Hypotheses to test:
- Use cases written as scenarios over the model are cheap enough to keep
  current, and their computed status is trusted.
- madarch's own code index (tree-sitter, SCIP) links scenario steps and evidence
  to symbols precisely enough to be useful.
- Normalized contract ids join facts from different repositories reliably
  enough to be useful.
- People and agents keep the corpus current when it lives beside the code and
  is checked on every change.
- A graph of 10^4–10^5 elements with full bitemporal history stays fast enough
  for interactive views with an embedded query engine.

## Direction

Done:
- MVP (`docs/milestones/mvp.md`): the intended model format with environments
  and architecture states, its storage with both time axes and LadybugDB as the
  query engine; readable views of a large invented system; an agent skill that
  writes a repository's model; a server returning its views; a wiki with
  diagrams.
- live-graph (`docs/milestones/live-graph.md`), ended early: the registry's
  integrity (stable ids, digests, idempotent immutable uploads, protocol
  versions).

Near (`knowledge-base`, `docs/milestones/knowledge-base.md`):
- The product wiki of one repository, from vision to code: the versioned
  document contract in one file, use cases and data entities in the model, the
  product section with backlinks, the data catalogue, deployments per
  environment and open questions; madarch's own code index for files, imports
  and symbols.

Next (`registry`):
- A product published from several repositories, joined at the contract
  boundary, with its portal; the wiki kept current without hands (a pull-request
  check, a publish after merge); the graph served to agents over MCP, locally
  and from the server; the call graph and interactions from code.

Later hypotheses:
- Data flow inside code (which value reaches which topic); history queries and
  time-travel portals; the glossary term registry.
- Pull-request comments on the git hosts; a runner for closed networks that
  uploads facts; runtime observation (tracing, broker ACLs).
- Adapters for other code-graph tools as evidence sources.
- Network access matrices and compliance exports generated from the graph.
- Authentication, single sign-on and access by product.
- Several independent graphs per server.

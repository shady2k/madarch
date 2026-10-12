# madarch vision

madarch keeps a product's knowledge as a graph: what people intend (its
vision, requirements, use cases, decisions and architecture), joined with what
madarch finds in its code, configuration and deployments, across every
repository the product spans. Its wiki is the product's single source of
truth and place of work — the product management system: everything about the
product lives in it, from ideas and the hypotheses that worked or failed,
through requirements, user journeys and customer-journey maps, architecture,
data-flow and sequence diagrams, design (wireframes dictated in the chat, then
React components from the product's UI kit in place of a separate design
tool), testing, deployment, information-security requirements, the tracker
(beads), milestones and plans, to the as-is and to-be of the architecture with
removals kept. The work itself is written there and launched from it:
agents take work from the wiki and their status shows live, and the main chat
is Lifemodel's (decisions 0017, 0018, 0021, 0022). It is
agent-first: an agent does most of the reading and writing, people decide and
make the occasional edit by hand. A reader goes from the product's purpose down
to the line of code that implements one step of one use case, and every claim
on the way names its evidence.

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
- Anyone looking for a general-purpose wiki or note-taking tool. madarch's
  wiki holds a product's knowledge in a form it checks, not free pages.

## Problem

- **An idea has nowhere to grow.** A new product starts as a conversation;
  what was decided, why, and which hypothesis a requirement came from is lost
  before the first line of code.
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
- **Design lives outside the product's knowledge.** The designers draw in a
  separate tool, so a control on a screen cannot be asked in which scenarios,
  services and code it takes part — and the design drifts from both the
  requirements and the code without anyone saying where.
- **The work starts outside the system.** Tasks go through messenger chats
  and separate trackers, so nobody sees in one place which agent works on
  which feature and in what status; a test stand is gathered by hand for
  every change, and the same shared stand is booked by arrangement, not by a
  queue.
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
| Wikis (Confluence, Notion, the GitHub and GitLab wikis), with or without AI | Their pages are free text: unchecked, unlinked to the architecture, the code or the work, and wrong a few months after they are written; an AI that edits them edits text, not a product's checked knowledge |
| Design tools outside the wiki (Figma and its kind), to be replaced per the owner's plan | The design is not part of the product's checked knowledge: a change of a control cannot be traced to the requirements, scenarios, services and code through the same backlinks, and the mockups drift from the code they depict |

The difference: a **product corpus in git**, in one product repository and
under one contract that madarch checks on every write and commit
(vision, requirements, use cases as scenarios over the model, data entities,
decisions, the intended model), **facts from madarch's own code index and
pluggable extractors**, joined by **normalized contract ids** across
repositories, kept **bitemporally**, checked against **rules** and against
what is still missing, and served to people and agents through replaceable
frontends.

## Key journeys

0. **Lena has only an idea.** She runs `madarch new`: a draft product opens
   as a wiki, with no name yet. Her agent talks the idea through with her in
   plain words and writes what comes out (a vision, hypotheses, the record of
   the conversation, then user stories, use cases and requirements), each page
   linked to what it grew from, checked as it is written, and listed with
   what is still missing. A prototype tests one hypothesis. When the idea
   becomes a product, the agent helps her name it and offers a git remote; an
   engineer can start from what is there.
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
8. **A business person dictates a screen.** She opens the wiki, talks the
   screen through with her agent, and walks away with requirements and a
   wireframe. A designer then composes the same screen from React components
   of the product's UI kit inside the wiki — to a pixel-perfect mockup the
   front end implements — and the button on the mockup answers where it takes
   part: its scenarios, its services, its code, and what removing it would
   break. The design tool that used to hold this is replaced by the wiki, per
   the owner's 2026-10-12 vision.
9. **A product engineer asks for a test stand.** From the affected features
   madarch computes which services and versions are involved, proposes the
   preparation steps, and the stand is assembled with exactly these versions
   at the time asked for. The shared one serves agents and people through one
   queue, and the run's report comes back where the request was written.

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
- Role perspectives computed on demand: the same graph read as the business
  side, the product engineer, the tester, the security engineer each needs it,
  not copies to keep apart.
- Approvals as a simple e-signature by role: the roles and their members live
  in the product; a rule names a role, never a person, any member may sign,
  and the signature keeps the person, the role and a digest of the approved
  revision. A change to someone else's requirement becomes a proposal for a
  role's approval before it lands.
- Agents and the work taken from the wiki: a task leaves through the wiki, the
  agent's status shows live in it, and the record of what was done links back
  to the requirement it served.
- Checks: dangling cross-repository references, contracts without providers,
  rule violations, drift between intent and code, broken scenarios, the corpus
  against its contract.
- One product repository per product as the one source of everything: the wiki
  and the work, a manifest of its code repositories, the team's skills and its
  constitution for agents; cloning it and running its bootstrap prepares the
  whole workspace. Each type of entity declares its storage form inside the
  product — a document under `docs/`, a task in the beads tracker, a model
  element, a React component with its story — and madarch shows an
  unimplemented form as a named finding, never drops it. The lifecycle of
  every entity keeps planned, active, retiring and retired against a
  milestone, so the to-be covers additions, changes and removals: a removed
  button or section stays in the record as retired at its milestone.
- Information-security requirements per repository, aggregated over the
  product: each repository keeps the checklist it must satisfy and where it
  stands, and the product's pages answer how the whole complies, so talking
  to security happens from the same wiki.
- Test stands assembled on request: the services and versions a change
  involves come from the graph, the stand is prepared for them, and the
  shared stand is taken through a queue, agents included.
- The same madarch locally and centrally: a local one serves a workspace, the
  central one serves the company and federates products; they sync through
  git, and the graph in LadybugDB is derived and rebuildable from it.
- Answers for people and agents over HTTP and MCP; diagrams through frontend
  plugins (Mermaid for documents, LikeC4 for navigation, graph databases for
  ad-hoc queries); impact analysis along the links, from a component to the
  scenarios, services and code behind it and back.
- The main chat is Lifemodel's (the owner's agent platform): work requests,
  statuses and page chat go through one chat that costs nothing to reach, and
  madarch stays the graph, the write path and the store that chat reads.

## Success signal

A newcomer answers "what is this product for, how does a use case run through
it, and where is that in the code" from madarch without opening the
repositories; an architect answers "who talks to whom, carrying what, and since
when"; and a pull request that breaks a use case or another repository's
interaction is reported before merge. The same wiki then holds the plans, the design and
the stand requests: a change runs from its requirement to its merged code
without leaving the product's own space.
Counter-metric: the effort to keep the
corpus current must not grow with the number of repositories; if people stop
updating it, the product failed even if the wiki looks good.

## Exclusions

- A manual diagram editor or a canvas.
- A proprietary query language; ad-hoc queries use Cypher through the query
  engine or an exported graph database.
- Storing secret values; only references to them.
- The agents' behaviour (brainstorming, naming, writing a use case, running
  work): it lives in the shady2k-skills set; madarch is the store, the checks,
  the graph, the wiki and the interfaces agents use.
- In the current milestone: see its charter, `docs/milestones/idea-to-wiki.md`.
- The later milestones the Direction names as hypotheses (the tracker and the
  agents, the chat through Lifemodel, roles and approvals, information
  security, test stands, the design and UI kit, federation): named, not opened
  — each still needs the owner's decision before it becomes tracked work.

## Constraints and assumptions

Known:
- Deployed by organisations themselves, often in closed networks: one Docker
  image, no outbound calls at runtime; the local mode needs no server at all.
- Open source, public repository: every dependency must be redistributable.
- Products span many repositories on different git hosts; GitHub and GitLab are
  the first webhook sources.
- A product's knowledge is kept in its own git repository, apart from its code:
  nearly everyone may write to it, while write access to code stays narrow.

Contract v1 (decisions 0021, 0022) reserves without implementing yet: the
storage form per entity type, product-scoped global ids, a lifecycle with
milestones on every entity, and a roles section in the manifest. The v1 engine
implements documents only, and reads the rest in.

Hypotheses to test:
- Use cases written as scenarios over the model are cheap enough to keep
  current, and their computed status is trusted.
- madarch's own code index (tree-sitter, SCIP) links scenario steps and evidence
  to symbols precisely enough to be useful.
- Normalized contract ids join facts from different repositories reliably
  enough to be useful.
- People and agents keep the corpus current when it is their place of work,
  checked on every change, and work launched from it writes its own links to
  the code.
- Git is a good enough store for a product team's edits when each edit is a
  commit and a conflict is shown, not silently merged.
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
- knowledge-base (`docs/milestones/knowledge-base.md`), ended early by decision
  0017: use cases and data entities in the model.

Near (`idea-to-wiki`, `docs/milestones/idea-to-wiki.md`):
- From an idea to a living wiki, for one person and their agent on their own
  machine: a draft product, the wiki updating as files are saved, the check on
  write and commit, linked vision, hypotheses, sources, user stories, use cases
  and requirements, prototypes, open questions, and the draft turned into a
  named product.

Next, as milestones:
- Agents through MCP and an API, and editing by hand in the wiki.
- Work launched from the wiki: code repositories, tasks and runs, feedback
  from madarch's own code index.
- The team and the central server: bootstrap, sign-in, single sign-on, roles.
- Federation of products at their contract boundaries, then company-wide
  abstractions.

Later, as hypothesis milestones — named, not opened; each becomes a
milestone only when the owner takes it up:

- Tracker and agents: the beads tracker read and written through the wiki,
  work taken by agents from it, their status live on the item, over one event
  stream of every change (decision 0022).
- The chat through Lifemodel: madarch's agent API as the published contract;
  Lifemodel joins as a channel plugin to carry the main chat, the work
  requests and the executions.
- Roles, approvals and signatures: the roles section, approval rules by role,
  e-signatures on the one write path, change proposals for edits to another's
  requirement.
- Information security: per-repository requirements in the product, the
  product aggregation, and the security engineer's reading of the same graph.
- Test stands: stands assembled on request from the affected services'
  versions, through a queue for the shared stand, with a report back.
- Design and the UI kit: wireframes from dictation in the wiki, then React
  components from the product's UI kit for the pixel-perfect mockup, the
  design embedded where the requirements and the code live.
- Federation: products linked at their contract boundaries, cross-product
  links shown as external links, then company-wide abstractions.

The owner's verbatim picture of these, recorded 2026-10-12:
`docs/vision/owner-vision-2026-10-12.md`.

Later hypotheses:
- Data flow inside code (which value reaches which topic); history queries and
  time-travel portals; the glossary term registry.
- Pull-request comments on the git hosts; a runner for closed networks that
  uploads facts; runtime observation (tracing, broker ACLs).
- Adapters for other code-graph tools as evidence sources.
- Network access matrices and compliance exports generated from the graph.
- Several independent graphs per server.

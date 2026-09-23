# madarch vision

madarch keeps a system's architecture as a graph: what people intend, joined
with what tools find in code, configuration and deployments, across every
repository the system spans. The graph is the product; diagrams, documents and
answers to agents are views of it.

## Audience

- **Architects** of systems that span many services and many repositories, who
  need to see and explain how the parts interact.
- **Engineers changing a service**, who need to know what their change breaks
  elsewhere before it merges.
- **Security and compliance engineers**, who need to know where data flows,
  which zones it crosses and on what grounds.
- **AI agents** working on such systems, which need architecture as data they
  can query, not as pictures.

Early adopters: teams already practising architecture as code (Structurizr, C4,
LikeC4, arc42) who have outgrown a single diagram.

## Non-users

- Teams whose system fits in one readable diagram: a Mermaid block serves them.
- Anyone looking for a drawing tool. madarch computes views; it does not offer
  a canvas to arrange boxes by hand.
- Code-level analysis for its own sake (call graphs, dead code): tools exist for
  that, and madarch consumes their results as evidence.

## Problem

- **C4 levels are fixed.** Context, containers, components and code leave no
  place for grouping by domain, zone or product, so a large system's context
  diagram becomes a tangle of arrows that shows nothing.
- **Layout is manual work.** Moving boxes so that arrows do not cross is hours
  per diagram and is lost at the next change.
- **Interactions are invisible in code.** A topic name, a host or a port usually
  lives in an environment variable set by a deployment repository, not in the
  code of the service that uses it. No single repository shows who talks to
  whom.
- **Models drift.** A hand-kept architecture model and the running system part
  ways, and nothing says where.
- **History is lost.** Nobody can answer "what did the integration look like on
  the day of the incident" or "what did we believe then".
- **Agents cannot use diagrams.** An agent needs to ask "where does personal data
  end up" and get a chain with evidence, not a picture.

## Alternatives and difference

| Alternative | What it lacks here |
| --- | --- |
| Structurizr, C4-PlantUML, Mermaid C4 | Fixed levels, one repository, no evidence from code, no history |
| LikeC4 | Good views and navigation, but its DSL is a diagram model: no facts, provenance, bitemporal history or cross-repository checks. madarch uses it as a frontend |
| Commercial tools (Ilograph, IcePanel and others) | Paid; closed data |
| Code-graph tools (codebase-memory-mcp, repowise, graphify) | They extract what code does, not what was intended; no domains, zones or data categories. madarch consumes them as evidence |
| Archi / ArchiMate | Manual layout and editing; no link to code |

The difference: an **intended model in git**, **facts from pluggable extractors**,
joined by **normalized contract ids** across repositories, kept **bitemporally**,
checked against **rules**, and served to people and agents through replaceable
frontends.

## Key journeys

1. **Irina, an architect, explains the platform to a new team.** She opens the
   organisation's graph at the level of domains: six boxes and a few aggregated
   arrows. She drills into "Billing", then into "Payments", each view readable
   because relations collapse to the visible level. She opens one arrow and sees
   the interactions behind it, the data they carry and the evidence for each.
2. **Pavel changes the orders service.** His pull request stops publishing an
   event. Before merge, madarch reads the branch, replaces the facts of the
   orders repository with the branch's facts and reports that two consumers in
   other repositories lose their provider.
3. **Olga, a security engineer, prepares for an audit.** She asks where payment
   card data flows. madarch answers with every chain, the zones each crosses, the
   rule that allows it and the file each link was found in; and it shows how the
   answer differed at the date of the last audit.
4. **An agent investigates an incident.** It asks the graph what depends,
   transitively, on the event bus in production and what that looked like at
   14:00 yesterday, and gets a chain with evidence instead of reading twenty
   repositories.

## Outcome

- One graph of a system across all its repositories: intended elements,
  interfaces and rules from the model in git; interactions, bindings and
  deployments from extraction plugins; each fact with its source and its time.
- Views computed from the graph: grouped by domain, product or zone, with
  relations collapsed to the visible level and drill-down to the detail.
- Checks: dangling cross-repository references, contracts without providers,
  rule violations, drift between intent and what was found.
- Answers for people and agents over HTTP and MCP; diagrams through frontend
  plugins (Mermaid for documents, LikeC4 for navigation, graph databases for
  ad-hoc queries).

## Success signal

An architect of a multi-repository system answers "who talks to whom, carrying
what, and since when" from madarch without opening the repositories, and a pull
request that breaks another repository's interaction is reported before merge.
Counter-metric: the effort to keep the intended model current must not grow
with the number of repositories; if people stop updating it, the product failed
even if the views look good.

## Exclusions

- A manual diagram editor or canvas.
- Code-level analysis of its own; extraction comes from plugins, including
  wrappers around existing tools.
- A proprietary query language; ad-hoc queries use Cypher through the query
  engine or an exported graph database.
- Storing secret values; only references to them.
- In the first milestone: see its charter, `docs/milestones/mvp.md`.

## Constraints and assumptions

Known:
- Deployed by organisations themselves, often in closed networks: one Docker
  image, no outbound calls at runtime.
- Open source, public repository: every dependency must be redistributable.
- Systems span many repositories on different git hosts; GitHub and GitLab are
  the first webhook sources.

Hypotheses to test:
- Normalized contract ids join extracted facts from different tools reliably
  enough to be useful.
- People and agents keep the intended model current when it lives beside the
  code and is checked on every change.
- A graph of 10^4–10^5 elements with full bitemporal history stays fast enough
  for interactive views with an embedded query engine.

## Direction

Near (MVP, `docs/milestones/mvp.md`):
- The intended model format, the fact schema, the bitemporal fact log and ingest.
- A large invented reference system rendered as Mermaid and LikeC4 views.
- A real repository's graph from its address, by static plugins, then completed
  by an agent skill that proposes the intended model.

Next (`live-graph`):
- Webhooks, CI and polling; pull-request checks; history queries; MCP; extraction
  from code; authentication.

Later hypotheses:
- Pull-request comments on the git hosts; a runner for closed networks that
  uploads facts; runtime observation (tracing, broker ACLs).
- Adapters for code-graph tools as evidence sources.
- Network access matrices and compliance exports generated from the graph.
- Authentication, single sign-on and access by product.
- Several independent graphs per server.

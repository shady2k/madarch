# 0033. One workflow walks the product graph by entity kinds, top down, and every node and edge is verified

Status: accepted
Date: 2026-11-01

Builds on 0022 (madarch as the product management system), 0026 (graph first, bounded agent
units, per-file deterministic stages), 0027 (stage registry, orchestrator, persisted state
machines, exactly-once publication), 0028 (one temporal graph), 0029 (what agents and people
write is Markdown in the product repository) and 0030 (the tip first, history from git). Amends
0026, 0027, 0028 and 0030 as the Decision and Consequences say. Agreed with the owner point by
point on 2026-11-01 (the record of the talk, with his words: docs/vision/architecture-talk-2026-11-01.md;
reviewed by Codex the same day, docs/explorations/0033-codex-review-2026-11-01.md).

Pending clarification/amendment, 2026-11-08: revised
[0034](0034-human-and-agent-work-interfaces.md) records the maintainer's
[PR 218 review](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890).
Point 28 protects wiki/graph text; free human task creation is not an exception to
that protection. Point 29's per-task human yes and human-only merge need the explicit
proposed replacement by owner-managed queue order and product-configured A/B/C lanes.
Work kinds use one uniform manifest rule and engine, not fixed starter statuses.
[0035](0035-work-reservations-and-operation-sync.md) distinguishes non-expiring
subtree work reservations from point 22's advisory verification and point 27's
expiring worker leases. These proposals do not claim implemented behavior; the
historical accepted decision below is preserved.

## Context and problem

On 2026-11-01 the wiki's fill of madarch's own product (madarch-product with the madarch
repository, engine at 4c2e932c) ended a 12 GB VM's fill worker with exit 137 at commit 0 of the
walk (about 9.8 GiB resident) and took down a 20 GB VM at the same stage. Measured on a 14 GB VM
the same day (memory-report.md of madarch-alzf): the code extractor alone, run on the first
100, 200 and 400 code files, returned in 28, 90 and 270 s, with end heap snapshots of 172, 481 and
1 200 MB; at 400 files the process held 5.27 GiB resident, 1.04 GiB of JS heap and 20.5 million
live objects.

The cause is not one defect but a second fill surface:

- 0026's stages (src/fill/stages: per-file syntax, per-file resolution reading the published
  facts) and 0027's orchestrator were built, but write to the old fact store
  (src/fill/fact-store.ts, `fill_fact`, initialised in src/fill/orchestrator-host.ts) that 0028
  replaced; only `madarch fill-stages` calls them.
- The wiki's fill (src/knowledge/fill-worker.ts) calls the extract driver
  (src/extract/driver/index.ts): the older extractors over the whole tree in memory, the code
  facts passed between extractors as an object, only the result published. Its tree reader loads
  every blob on its first read (src/extract/driver/git.ts:167); name resolution
  (src/extract/code/resolve.ts:62, called per file from src/extract/code/index.ts:355) rebuilt
  the whole tree's symbol table for every file, so time and memory grew quadratically.
- The same pattern stands elsewhere: two agent paths (0026's agent stages 8-13 on `fill_fact`; the
  writer of 0029/0032, src/writer), a separate verification runner with its own budgets and
  caches (src/knowledge/graph-verdicts.ts), stores 0028 retires (`fill_fact`, src/history,
  src/query), and about 25 modules outside src/graph and src/adapters that run SQL themselves.

It came from madarch-o0eq.5 (2026-10-21) leaving "retiring today's stores" out of scope with no
follow-up task, and from accepting the driver against its own brief instead of against 0026.

## Decision

### One of everything, enforced

1. **One workflow engine.** 0027's stage registry and orchestrator run every job: the wiki, the CLI
   and MCP start work only through it. "Workflow" is the owner's word for a business process; there
   are several. The writer's units and the useful responsibilities of 0026's agent stages 8-13
   (module boundaries, intent from comments and commits, bottom-up module understanding, recovered
   architecture beside the intended one) become stages of this registry; graph-verdicts' checks and
   escalation become its verification stage.
2. **Workflows are product data** in the product repository (`madarch/workflows.yaml`, beside the
   kinds and POV). The engine ships a starter set: first fill, update by commit, branch/worktree,
   history point. Stages are engine code referenced by id; a workflow that names a missing stage
   or leaves a stage's input without a producer fails the manifest check.
3. **One storage layer with one transaction boundary.** One interface per store (graph, workflow
   state, queue), and one owner-side atomic operation that publishes a unit's facts, settles its
   queue job and writes its durable events together (0027's publication). Only this layer holds a
   connection or runs a query. Locally it is one embedded-database owner per machine, which
   workers reach through the interface; on a server, PostgreSQL with a globally fenced
   publication authority. Workers submit drafts through that boundary; they never publish.
4. **Static architecture checks** in `bun run check` and CI, for the whole architecture: one
   writer per store; one entry point per job, and no entry surface starts a runner of its own; no
   module outside the storage layer imports a connection or runs a query; no code or export
   unreachable from the declared entry points. Rules live in one configuration in the repository
   and change only in a commit that carries the owner's decision. Tools: dependency rules over
   the import graph (dependency-cruiser), unreachable-code detection (knip), and type- and
   AST-aware checks over the code graph; no regular expressions over source text.
5. **Capability boundaries.** Import rules do not see algorithmic cost, so the static worker's
   interface is the bound: a static stage receives one file's bytes and bounded graph queries,
   and no whole-tree reader or repository-wide semantic object exists for it to call. A type-aware
   check fails any static stage that obtains one. A file above a size limit is read as far as the
   limit and reported as a gap.
6. **Greenfield.** Everything replaced is deleted in the same work, never left for later: the
   extract driver (src/extract/driver), the `fill_fact` store, 0026's agent stages in their current
   form, the knowledge fill worker's own loop, src/knowledge/graph-verdicts.ts as a separate
   runner, src/history and src/query, and whatever the reachability check finds. A
   responsibility-to-replacement inventory (extraction, writing, verification, indexing,
   publication, recovery) names where each responsibility goes before its old code is deleted.
   No compatibility path, no dead code.

### The graph and its catalog

7. **Two vocabularies, mapped.** The extractors keep their own code-structure vocabulary (0026,
   0028 "Tables"); the product's kinds are the catalog's. Versioned mappings tie one to the other.
   A product that removes a kind changes what it shows and walks, never what extraction keeps.
8. **The entity catalog covers the whole life cycle now**, every area at once, with unimplemented
   kinds marked. It is data: every kind has an id, a definition, its area and subgroup, its
   sources (the standard or document it was taken from, linked so a person can read it), the ways
   it can be acquired, its implementation status, its relation constraints and its template
   policy; a mechanical check validates them. Two levels, area -> subgroup -> kind, a subgroup
   holding about 12 kinds at most. One canonical kind per concept: a concept that two areas share
   lives in one subgroup and the other refers to it; distinct senses are not merged (a vision is
   not a product goal; a persona is not an actor or a role; a DDD repository is not a Git
   repository; a release, a tag, a version and a Helm release differ; desired and observed
   deployments differ). Values (versions, coverage, RTO and RPO, token values, translation states)
   are attributes or measurements, not kinds; relation names (ownedBy, dependsOn, SPDX 3 names)
   are relations. Relation names come from the standards where they exist (SPDX 3, Backstage, C4).
   The kinds the extractors already emit (repository, directory, broker, metric, probe,
   healthcheck, field, debt, document section) join it.
9. **The catalog's areas** (each with its subgroups in the catalog data): strategy and business
   motivation (OMG BMM, ArchiMate); discovery and user research; requirements, their changes and
   assurance cases (ISO 29148, ISO 25010, OMG SACM); R&D; design, frontend, accessibility
   evaluation (W3C design tokens, WCAG 2.2, ACT, EARL) and localisation (XLIFF, Unicode TR35);
   architecture, behaviour and architecture description (C4, Backstage, arc42, DDD, UML state
   machines, BPMN, ISO 42010), technologies with versions and end of life, external services
   (SaaS, PaaS) and integrations; code and interfaces (routes, gRPC, WebSocket, SSE, contracts,
   messages); information flows, each item passed linked to a glossary term, and information
   categories (personal data, communications secrecy, trade secret); data, data checks, catalog,
   quality and provenance (OpenLineage, DCAT 3, DQV, PROV-O); messaging, caches, storage (object,
   block, file transfer), notifications (e-mail, SMS over SMPP, push); testing (ISTQB), checks and
   contract verification (Pact), performance, capacity and chaos experiments; code review; CI/CD,
   build and supply chain (SLSA, in-toto), releases, release gates and rollouts, GitOps
   (OpenGitOps), feature flags (OpenFeature); infrastructure: compute (servers, Kubernetes
   clusters, node pools, nodes), network (zones, firewall rules, security groups, WAF, load
   balancers and proxies, DNS, domains, IP ranges, ports, protocols, certificates), IaC;
   operations: SLOs and error-budget policies, observability and its telemetry pipeline
   (OpenTelemetry), alerting and routing (Alertmanager), scheduled jobs, incidents and response
   records, maintenance and changes; resilience and continuity (NIST SP 800-34: business impact,
   plans, recovery objectives, backups and recovery points, replication and geo-redundancy,
   failover, drills and results); security: findings (SARIF), vulnerabilities and VEX, SBOM and
   licences, threat models, threat intelligence (STIX 2.1), access (IAM, roles, accounts, grants,
   reviews, SSO, SCIM), controls (OWASP ASVS, security target and protection profile of ISO 15408),
   assessments (penetration tests, scans, bug bounty), disclosure and response (NIST SP 800-216,
   RFC 9116), audit and exceptions; privacy and compliance (W3C DPV, GDPR art. 30, NIST OSCAL);
   costs (FinOps FOCUS: licences, cloud, LLM use, budgets, allocation); suppliers and agreements
   (NIST SP 800-161); ML and GenAI life cycle (MLflow, ML Metadata, NIST AI RMF); documentation and
   support; organisation, ownership and assignments (W3C ORG; CODEOWNERS is review ownership
   only); history and work; process automation (each process step done by hand, automated or by
   an agent); decommissioning (NIST SP 800-88, RFC 8594). The catalog's list is checked for gaps
   by a reviewer against the standards, and agents note missing and unused kinds on real products.
10. **Origin marks** on every kind (one or several): extractor `<id>`; document (an authored record
   in a repository, read by meaning, with the document revision, section and evidence span as
   basis); conversation (a person and the agent in the wiki); agent from the graph (C4
   components, DDD boundaries, groups); live system (an imported observation from a cloud,
   cluster, DNS provider, tracker or forge; not implemented in the MVP); not implemented (a
   place, relations and a template, no producer yet; still creatable by conversation). Where an
   unimplemented kind would apply, the agent records an applicability note, never a fake
   extraction.
11. **Groups.** No node has more than about 50 children; above that the engine inserts a group
   found by clustering the graph (0026 Scale).
12. **POV.** A kind belongs to exactly one subgroup; a role lists the areas or subgroups it leads.
   Roles: product, analyst, architect, developer, operations, tester, designer, security
   engineer, platform/DevOps, product lead. When a person of a role talks to the agent, the agent
   starts from that role's areas.
13. **Two sides.** The graph holds what is intended (documents and conversation) and what is
   implemented (extraction and verification), with independent mappings between them. Divergences
   are detected, recorded and shown on their pages automatically.

### The code pass: a library reads one repository's tree (amendment, 2026-11-06)

The owner decided, in his words: **"Да, берем."** He was asked to take
`@colbymchenry/codegraph` (MIT) as the first pass for code, and was told that this changes items 5
and 14, because the library reads the whole repository rather than one file. His rule for passes
holds: the cheapest step first, even if imprecise, each next step refines and costs more, and an
agent pass comes last; we do not write our own reader per language where a library exists. His
other rules stand: no pattern of a repository is hardcoded (we have no idea what a repository looks
like and must not guess), equality with the old reader is no criterion, and classification is jev's
or a weak model's, never a rule's.

The stage is one more static stage of the fill, through the one orchestrator and the one fill
entry. Per run and repository it writes the commit's blobs from the snapshot reader into a
throwaway folder outside the checkout, indexes that folder with the library **through its library
API** (never its CLI or its MCP server, which are the two surfaces that report telemetry to the
library's endpoint; the run sets `DO_NOT_TRACK=1` as well), reads the library's nodes and edges,
and publishes them through the ordinary draft and publication. The folder is deleted afterwards.
The library is pinned to one exact version in `package.json` and the lockfile.

What this stage publishes, and what it does not, is decided by measurement, not by preference
(`/work/out/report-codegraph.md` and the score of item 6): the per-file passes of ours state
fields, files and test cases at least as well as the library does, so they keep those kinds; the
library's calls are better on both precision and recall at the same repository, so calls,
references, implementations and inheritances come from it. Each edge carries how it was obtained
and how far it is trusted — the library's `resolvedBy` and confidence — and `provenance` names the
pass; a low-confidence edge is kept, because a later pass refines it and does not re-read the tree.
A record's place is the library's line and column. An interface-to-implementation link is an
`implements` edge, not a call; a constructor call is a call, as the reference states it. The
mapping from the library's vocabulary to ours is one table of data in the stage, printed in the
report; a kind with no honest counterpart of ours stays out and is named there.

The Go limit of the library (1.6.2 reads only the `go.mod` at the index root) is met without
patching it: the stage finds the module roots by reading the tree — every folder that holds a
`go.mod` — indexes each as its own root, and merges what the indexes hold, one source per file.
The effect is measured and reported.

For this stage, then, the unit of static work is one repository's tree at one pinned commit, and
its memory is the library's index of that tree — measured and reported with the run (230 MiB and
0.4 s on the training repository; 1.8 GiB and 28 s on madarch's own 1 263 files, as the
measurement before this change found). Every other stage keeps the file as its unit.

### The walk

14. **The file is the unit of static work.** A file's pass reads only its bytes and writes its own
   facts: symbols with global names, mentions, imports as written, gaps. Cross-file links are
   resolved per file by querying the graph by global name. Memory is bounded by one file.
15. **Steps build on each other.** The file pass creates the nodes; every next step reads what the
   earlier ones published. The kinds declare which kinds their discovery depends on, separately
   from the relations a reader navigates; the workflow derives the order from those
   declarations and validates them. Every step is a background worker pool sized in the workflow.
16. **Every node and edge is verified, and the verifier's decision is final.** Static extractors
   draft; the agent checks, adds and removes edges, creates, renames and merges nodes. A confident
   jev verdict counts as verified and is marked as jev's; what jev is unsure of goes to the agent.
   Verification and implementation are different checks: a requirement can be verified as
   faithfully recorded from a person or a document and still be unimplemented or contradicted by
   the code. Agent verification, human acceptance and proposal stay three separate checks (0026,
   0028's digest-bound acceptance).
17. **Top down.** The walk starts from the idea level (product, goals, domains, scenarios,
   requirements) and descends through services and modules to code, so the agent's context fills
   with related knowledge and the logic is checked against the code (the reflexion model). Within
   a level, large and important nodes first. A node of an implemented kind is verified once
   confirmed down to its evidence. Nodes no path from above reaches get their own turns last.
18. **Termination.** A verification epoch is pinned to a graph and input revision and keeps a
   persisted frontier and verification certificates keyed by the element's revision and the
   verifier's configuration. A shared descendant is verified once per dependency revision; a
   cycle is verified as one strongly connected component; discovery and reconciliation rounds
   and retries are bounded; what stays unresolved becomes a question. An epoch closes with its
   coverage, complete or partial, before later commits open the next.
19. **Cost.** Every workflow has budgets: money, tokens, calls, elapsed time, concurrency. Work is
   batched, evidence and certificates are reused, and partial completion resumes. Coverage is
   reported as verified, static only, stale and disputed counts against a pinned denominator; an
   exhausted budget is reported as partial coverage, never as full verification.
20. **A turn ends when its context does** (0026: wrap-up at 70 %, stop at 80 %). The workflow seeds
   the next turns from the frontier.
21. **Notes on nodes and edges**: what the verifier confirmed, corrected and suspected, with grounds,
   a handoff note on the frontier at the end of a turn and its summary. Execution checkpoints are
   disposable workflow data; disputes, grounds and findings that carry knowledge are durable and
   kept in the product repository. A rebuild loses only the disposable part; a kept certificate
   is revalidated against its evidence and configuration digests before reuse.
22. **Parallel agents, optimistic.** Every agent sees and navigates the whole graph. A reservation
   tells the orchestrator where an agent works so it spreads agents; it forbids nothing. An
   agent's draft is divided into dependency-closed parts; each part is published atomically and
   once, with its full read set (including negative reads and query membership), generation,
   fence and cancellation check. A part whose reads changed is refused and comes back to the agent
   with the other agent's change, basis and note, as a replacement generation; the agent agrees,
   amends or disputes. An unresolved dispute becomes a question for a person with both positions
   on the node's page.
23. **Corrections are an overlay.** A correction names its target identity and revision digest,
   the operation, the basis, the author and what it supersedes; it is kept in the product
   repository (0029). The raw extraction is kept; reads combine extraction and corrections; a
   suppression survives re-extraction; a correction whose basis or target changed loses its
   verified state and returns to the frontier. A merge of nodes follows 0028's predecessor and
   new-identity rule, with its edges reconciled.
24. **States are separate dimensions**: freshness (current, stale), verification outcome
   (verified by an agent or by jev, refuted, disputed, static only), provenance, human acceptance
   and life cycle (intended, implemented, retired). Whatever an element depends on changing makes
   it stale, including a vanished dependency, an empty query that gains a result, a changed
   correction and a changed verifier rule. The wiki shows badges and a "verified only" filter;
   MCP returns the states with every fact; coverage is shown per page and for the product.

### Updates, branches and people

25. **By commit, in the background, never blocking it.** A hook only tells the background server;
   a server that was down picks up missed commits at start. Static work runs at once for the
   changed files; agent verification starts at the highest node that turned stale and descends,
   over commits batched in a window, within the workflow's budget.
26. **Every branch and worktree.** A branch context names its immutable base commit and its overlay
   revision; it has its own fenced publication namespace, and every traversal, cache key, tracked
   read and correction carries it. The base is the merge-base, materialised as a chosen point
   (0030) when the graph does not hold it. The overlay holds the changed files' facts
   (uncommitted worktree files re-read per file on an MCP query), shadows and tombstones the
   base's, and invalidates the changed files' dependency closure, including query membership and
   negative reads. Agents verify what the branch touches, within the branch workflow's budget.
   Rebase, force-push and branch removal replace or drop the context; dropped contexts are
   collected. A branch never writes the default branch's history; valid time stays 0028's, and
   when branch evidence was learned is recorded separately. At merge a verification certificate
   moves to the merge publication only when its whole evidence and dependency digest is the same
   in the merged tree, keeping its branch provenance; everything else is re-verified.
27. **Workers.** One background server per machine owns the database, the orchestrator and the
   queue. Static steps run in separate processes (default: the number of cores); agent steps run
   many sessions concurrently, bounded by sessions and the model gateway. A crashed or leaking
   worker is replaced; its lease expires and its unit returns, fenced so a late worker is refused
   (0027). Several machines share one queue and one fenced publication authority on PostgreSQL. A
   memory budget covers workers, the database, queues, IPC buffers and retained results; the
   orchestrator admits no work beyond it.
28. **Nobody edits the wiki or the graph by hand.** A person tells the agent (text in the MVP, voice
   later) and the agent walks the whole chain. The person's words are stored verbatim, with who
   and when and the conversation, before the agent interprets them; the interpretation, the
   disagreements and the work it causes link to that record; the agent shows what it retained;
   an interrupted interpretation is replayed from it. A person's intent stays visible when the
   code contradicts it; code evidence never erases intent. Conversational writes go through the
   same accepted write path, durable events and idempotent git publication as every other write
   (0022).
29. **The whole life cycle runs through the wiki**: an idea dictated to the agent, user stories,
   wireframes, use cases, requirements, ADRs, development, tests, deployment. A divergence between
   intent and implementation is recorded and shown as a work item automatically. In the MVP it
   goes to an agent for execution only on a person's yes; later a workflow setting sends it to an
   agent, which brings a pull request that a person merges or returns (the wiki as the tracker,
   madarch-lk4r). 0022's boundary stands: development and deployment execution stays outside the
   fill's orchestration, behind the external executor contract.

## Consequences

- Amended 2026-11-06: the code pass reads one repository's tree at the pinned commit with
  `@colbymchenry/codegraph` (MIT, pinned) and supplies calls, references, implementations and
  inheritances; items 5 and 14 hold for every other static stage unchanged.
- 0026 amended: its stage list is replaced by stages per entity kind and the verification walk;
  its unit limits, agent tools (code only through MCP evidence spans, checked writes), per-file
  deterministic stages and separate vocabularies stand.
- 0027 amended: publication is per dependency-closed part of a unit's draft, each part atomic and
  once; workflows live in the product repository; the owner-side atomic operation spans graph,
  workflow state and queue.
- 0028 amended: corrections are an overlay with their own ownership; branch contexts carry their
  own publication namespace beside the default branch's history; the old stores are deleted.
- 0029 stands; corrections, durable notes and people's verbatim words are Markdown records too.
- 0030 amended: a merge-base not yet in the graph is materialised as a chosen point.
- 0022 stands; the external executor boundary is kept.
- MVP: everything above except live-system import, autonomy, voice, the full tracker and
  signatures by role. The whole catalog is in the MVP as data, unimplemented kinds marked.
- Cost: a large rework of src/fill, src/extract, src/knowledge and src/writer. Until it lands,
  madarch's own fill does not run, because its current path is the one being deleted.

## Review

Codex, 2026-11-01, one round: eight blocking findings (partial publication against 0027/0028's
atomicity; corrections without an ownership mechanism; branch layers without a temporal and
publication contract; unsafe merge-base inheritance and certificate transfer; a person's words
could be lost; no termination rule; no cost contract; the checks would not have caught the
Context's defect) and ten others (missing agreed points, verification versus implementation,
state dimensions, durable notes, catalog as data, the two vocabularies, the transaction
boundary, 0022's executor boundary, graph-verdicts as another surface, qualified evidence), and
about thirty catalog gaps. All are taken into this text.

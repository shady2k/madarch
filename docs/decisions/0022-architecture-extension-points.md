# 0022. The architecture's extension points: one graph, one source, one event stream, one write path; Lifemodel joins through the agent API

Status: accepted
Date: 2026-10-12

Amended 2026-10-12 (owner decisions of ~22:15 MSK): the storage forms gain a
fifth form `fact` — an entity imported from a system, carrying its evidence
and read-only in the wiki — reserved in v1; and the manifest gains a reserved
section for goals and maturity levels, whose engine work stands deferred
(madarch-wkne), not opened. Both folds are in the sections below; the status
stays accepted.

Refines 0017 (the product wiki as the source of truth and the one write path)
and its boundary record 0021 (the product repository contract); builds the
seams the graph-as-product record 0001 kept open, extends the id scheme of
0003 and the fact layers of 0004 and 0005, keeps 0009's bitemporal fact log as
the one record of change, and reads 0015's architecture-state chain as the
lifecycle of every entity.

## Context and problem
Decision 0021 fixed the contract on which the engine ends its current
milestone, and contract v1 reserves four things it does not implement yet: a
storage form per entity type, product-scoped global ids, a lifecycle with
milestones, and a roles section in the manifest. The owner's vision of the
same day (2026-10-12, `docs/vision/owner-vision-2026-10-12.md`) then drew the
whole picture: designers and product engineers work inside the wiki; work
goes to agents from it and their status shows live; test stands assemble on
request; approvals are e-signed by role; the main chat is Lifemodel's; the
wiki federates across products. None of that is in the engine today, and the
engine must not grow a bespoke path per feature later. The question this
record answers: which extension points does the architecture commit to now,
so that these features arrive by plugging in rather than by rewriting
modules?

Lifemodel (`/home/dev/repos/lifemodel`, read-only for this record; README,
`docs/architecture.md`, `docs/plugins/`) is the owner's agent platform: a
three-layer brain over a one-second CoreLoop where everything entering the
system is a Signal; channels are strictly-isolated plugins that turn external
input into signals and carry outbound sends back; the Motor Cortex runs
agentic executions inside per-run sandboxed Docker containers. Its core never
imports plugin code; plugins reach it through a small primitives API and
declare themselves in a manifest.

## Considered options
1. **Build each later feature straight onto the engine's documents.** Roles
   bolt onto the wiki app, approvals into the document check, the tracker and
   the chat into their own panels beside the documents each with its own
   storage. No rewiring of the core is needed early, but the one-source rule
   of 0017 splinters into per-feature stores, agents read several currents
   instead of one event stream, and every later feature rewrites what the
   feature before it hardened.
2. **A plugin system inside madarch's core** for roles, approvals, executors
   and channels, on Lifemodel's plugin pattern: each concern arrives as a
   madarch plugin. The seams stay hot, but madarch ends up carrying
   platform logic of its own — channel transports, executor queues, approval
   engines — and the Lifemodel join becomes code against code, which 0021's
   no-code-dependency rule and the set's plugin isolation both refuse.
3. **Named extension points at the architecture's seams, and the outside
   platform through a published contract** (decided): the graph with
   product-scoped ids, the product repository as the single source with a
   declared storage form per type, one event stream of every change, a
   lifecycle field on every entity, views computed on demand, and one write
   path with the hooks roles, approvals, signatures and change proposals plug
   into later. Actions and executors stay outside madarch: the agent platform
   (Lifemodel) joins through madarch's published agent API as a channel
   plugin, the way a Telegram channel plugs into Lifemodel today.

## Decision
Option 3, decided by the owner on 2026-10-12 in the same conversation that
produced the vision record; the contract-v1 reservations (storage forms,
product-scoped ids, lifecycle, roles) are the first piece of it and are
quoted here as decided.

- **One graph, product-scoped global ids.** Entity ids are
  `<product-id>:<local-id>`; the product id is the UUID `madarch new` writes.
  Duplicates are impossible by construction. A link to another product's
  entity uses the same syntax, carrying the other product's id, so
  federation (0003) needs no second id scheme. v1 resolves local links and
  shows a cross-product link as an external link, with no finding.
- **The product repository is the one source**; there are no external
  catalogs for any kind of fact (0017). Each entity type declares how
  it is stored inside the product: `document` (Markdown under `docs/` —
  the only form v1 implements), `task` (the product's tracker, beads in
  `.beads/`), `model-element` (model YAML), `component` (a React component
  plus its story, for screens and the UI kit), and `fact`: an entity
  imported from a system — a code index, GitOps/IaC, a CMDB, a cloud
  inventory, a broker, tracing — carrying its evidence (the source system,
  its ref or commit, the record id). A fact is read-only in the wiki: the
  system it came from holds its truth. Authored entities and imported facts
  live in one graph, with the same ids and links, told apart by provenance
  (0005). CMDB-like configuration items (0006's deployment layer:
  environments, clusters, hosts, endpoints, ports, topics) are entity types
  of this graph, declared by people (a planned stand) or imported (a
  discovered host). v1 reserves the form only. The engine reports a form it
  does not implement as an honest "not supported by this engine version"
  finding and never drops the entity.
- **One event stream of every change.** An accepted write keeps the order the
  house has: the git content of the product takes the write (0017: nothing
  madarch keeps is more authoritative than git); madarch appends the change
  to its bitemporal fact log (0009), the server's append-only record of what
  it knew and when — the query engine 0009 pairs with it reads that record;
  and the change's fact is published on one stream. The stream is a current
  of notifications over accepted writes, not a source: reading it tells what
  changed; the truth of the product's content is the git content, and the
  log carries what madarch knew of everything else. The wiki app, agents and
  later consumers subscribe
  to this one stream instead of watching the filesystem, polling pages or
  each keeping its own store. This is where "agents work with the wiki and
  their status is visible live" comes from: agents are subscribers to the
  same events other readers get.
- **A lifecycle on every entity.** The generic fields carry planned, active,
  retiring and retired, each state tied to a milestone. 0015's chain of
  architecture states becomes this lifecycle: to-be covers additions, changes
  and removals, and a removed button or section keeps its record retired at
  its milestone instead of vanishing. v1 reads and shows the state; views
  sliced at a past state come later.
- **Views are computed on demand and never saved.** No saved graph slices:
  what the reader or agent sees is computed at the moment it is asked for
  (0001's computed views), because a saved slice goes stale against the event
  stream and forks the graph. Between requests, the wiki app and agents hold
  their subscription to the stream and the disposable local state it filled.
- **One write path with later pluggable hooks.** The server's write path
  (0017: check, write, commit as the author) is the seam every later
  permission mechanism plugs into: roles, approvals by role, e-signatures
  and change proposals attach to it in the order it keeps, rather than as a
  second path a write may accidentally skip. Approval rules name roles,
  never persons; any member of a role may sign; the signature records the
  person, the role and a digest of the approved revision. A person editing
  another's requirement produces a change proposal for a role's approval.
  v1 validates only the roles section's shape in the manifest.
- **Goals and maturity levels are manifest data, reserved.** Rules over the
  graph — counts by type and status, required-link coverage, provenance
  agreement, approvals by role — grouped into levels, per product and per
  role perspective (business, architecture, security, testing, ops). A
  product carries the section before the engine understands it: the engine
  reads the manifest without failing on the reserved section. Progress is
  computed on demand in a later milestone (tracked in the tracker as
  madarch-wkne, deferred; not opened).
- **Actions and executors through Lifemodel, joined by the contract.**
  madarch provides the graph, the write path, the event stream and the
  agent API; the agent API is a published, versioned contract with a schema
  and conformance examples, on 0021's pattern for the repository format.
  Lifemodel joins as a channel plugin over that contract: madarch's page
  chat, work requests and task statuses go through it as signals, and its
  outgoing actions — a task to take from the wiki, a run to ask for,
  a message into the chat — arrive as Lifemodel intents its channel and
  Motor Cortex carry out. The queue of agent work lives on the Lifemodel side
  too, with the shared test stand's queue as its first user; madarch names
  what the work needs and hears what became of it, through the same
  contract. Lifemodel is not in madarch's code and madarch is not in
  Lifemodel's; either runs alone, and the contract keeps them replaceable.

## Consequences
- The features named in the vision record arrive as work at these seams, not
  as engine rewrites: the tracker and agents on the event stream plus the
  contract's task storage form; the chat through the Lifemodel channel
  (filed in the tracker as deferred: lifemodel as the first outside agent of
  agent-access, working with the wiki over its API); roles, approvals and
  signatures as hooks on the write path;
  test stands as an executor atop the same contract, queued because the
  shared stand is one machine with one queue.
- The contract gains this record's reserved pieces first (the task storage
  form, product-scoped ids, lifecycle fields, the roles section, and, from
  the 2026-10-12 amendment, the `fact` storage form and the goals-and-
  maturity manifest section), each
  declared in the schema so products written by older engines are refused by
  naming the contract version range the schema accepts, the way the existing
  contract's version check behaves, and never silently parsed away. A
  reserved piece the engine does not implement yet shows itself, never
  vanishes: an unimplemented storage form is the honest not-supported finding
  the one-source bullet keeps, and the goals section is read by name and
  carried without a failure.
- Unsaved views mean the wiki app builds its pages on request even in the
  server mode; nothing in madarch saves a rendered graph or a view. A
  subscriber's local state stays what it is: a disposable cache the stream
  filled, thrown away and rebuilt from the graph, never a saved slice that
  stands in for one. Time-travel queries stay queries over the fact log
  (0009), never a stored slice.
- The lifecycle states, the roles section and the goals-and-maturity levels
  land in the manifest before the engine implements anything over them, so a
  product's git history carries the vocabulary from the day it starts.
- Revisit if madarch needs a second write path for a feature (a bulk import,
  a migration tool): such a tool goes through the same write path under a
  distinct author, or the seam must be widened rather than bypassed.
- Revisit if Lifemodel's contract drifts from what madarch's agent API
  publishes: the channel contract's versioning is the seam, and drift means
  a madarch API version range is named, not a code change on one side.

# The agent fills the fields no plugin does

Change: agent-fill
Base: a6382f4dcf4994130186f8a504f69c2b48352856
Tasks: madarch-64o5.63, madarch-64o5.49, madarch-64o5.60
Kind: behavior

## Intent
A fill leaves to the general agent plugin exactly the fields no enabled deterministic producer fills, so a person can
press a fill of any kind and have it filled: the plan names which plugin fills which field, the agent's reads let it
work from the graph, and a plan that needs an agent says so before a single unit runs instead of quietly filling less.
The agent's own contract for a kind is derived from that kind's declaration, its answer is held to it, and the run keeps
what the agent spent beside the cap the press named.

The catalogue no longer carries an implementation status: every field has a producer, and what no static plugin fills is
the agent's (decision 0035, items 16 and 22). The `status` field and its schema, the GraphQL catalogue field, the starter
data and the guides that declared it are gone.

A kind or field left without any producer because a plugin is missing, disabled or broken — the agent plugin included — is
abnormal, not a kind of state: the plan states an error naming the kind, the field and the missing plugin, and the run
fails that kind with the error while the other kinds run. It is never a kind's status, a badge or a filter. A product that
holds no agent plugin and whose kind is people's own writing, every field naming a person, has nothing to extract: that
kind is no error, and a tracker-only product still fills as it did.

## Out of scope
- A real model or a real agent: every test runs a scripted ACP peer, and no run starts an adapter's model.
- Static plugins for the kinds the agent fills today, and the technical task decision 0035 item 23 raises for them.
- An agent-written plugin inside a turn (decision 0035, item 28) and the accuracy measurement of item 2.
- Migration of products already initialised: a product's own catalogue keeps whatever its files say until the product
  edits them; a manifest that still writes a kind's `status` is refused by name, as any unknown field is.
- The wiki's page components: the fill plan is answered by the route, and the page that shows it is later work.

## Preserved contracts
- fill-stages/registry: the stage contract and the derived graph are unchanged; only the plugin turn stage's plan learns which fields are the agent's.
- fill-orchestrator/publish: a unit publishes its generation once, in one transaction, as before.
- product-repository/manifest: a field's `binding` still names its producer, `agent` included; a manifest that declares a producer for every field binds no agent and runs without one.

## Coverage
- fill-orchestrator/field-producers: test
- fill-orchestrator/missing-plugin: test
- fill-orchestrator/publish: test
- fill-stages/registry: test
- product-repository/manifest: test
- product-wiki/fill-plan: test
- product-wiki/catalog: test

## Where it is seen
Kind: command
Place: `madarch fill` and the fill route
1. On a product whose two decision records are in a code repository, run `madarch fill --entity doc.decision`, naming the agent with `--agent` and capping its spend with `--token-cap 100000`.
2. The command prints `Filling in dependency order: code.repository, code.directory, code.file, doc.decision.` and names the files it fills first.
3. Without the agent flag, the same command stops before any unit and names `doc.decision (legacy_id, title, body)` as the agent's fields.
4. With the agent, the run's unit list shows `plugin-turns/agent-fill:doc.decision` beside the files producer's units, and the kind's page shows each decision with the file and lines it was read from.
5. `POST /api/fill-plan` with `{"selected": ["doc.decision"]}` answers the same plan: every field, its producers, and the field list that needs an agent.

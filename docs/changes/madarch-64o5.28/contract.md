# Declaration-driven fill contract

## Kind manifest

Each kind declares `derives-from`, a list of kind IDs required to fill it.
An empty list declares no prerequisites. This replaces `depends-on`; there
is one interpretation, not parallel legacy and new dependency graphs.
Kind descriptions remain the source of meaning; only plugins interpret data.
The starter-kind dependency drafting belongs to the kinds-as-files work.

```yaml
kinds:
  document.summary:
    description: A summary grounded in the product documents.
    derives-from: [document.source]
    template: templates/summary.md
    source: graph
```

## Plugin manifest

A plugin's plugin.json uses the same declaration represented below as YAML
for readability. Existing name/version/entry/runtime and agent rights remain.
`produces` is a nonempty list: each entry names a kind and either `fields: "*"`
(the whole entity) or a nonempty list of field names. `reads` lists input
kinds. `refines` lists plugin names whose overlapping output this plugin
refines. `concurrency` is an optional positive integer limiting that plugin's
simultaneous units; no numeric order or global parallelism field is accepted.
A wildcard kind `"*"` in produces means every kind declared by this product;
it is expanded before validation. No plugin category or handler type exists.

```yaml
name: general-agent
version: 1.0.0
entry: index.ts
runtime: {name: bun, version: 1.4.2}
produces:
  - {kind: "*", fields: "*"}
reads: []
refines: [document-index]
concurrency: 1
agent:
  prompt: Fill the selected kind from its description and declared inputs.
  catalogue: true
  roots: [product]
```

The packaged general agent plugin declares wildcard output and refinement of
all other enabled producers (expanded from the product's enabled plugin set,
not a hardcoded engine list). `refines: ["*"]` is the manifest form for that
expansion, excluding itself. It is an ordinary plugin, available for every
kind including one without another producer. Agent ID and token cap are run
inputs offered through the existing host agent service to every plugin that
requests it, never a marker that divides plugins. Tests use scripted agents.
Checks declare output of the catalogue's Problem kind, not output-free runs.

## Startup validation and refusal messages

Validate before accepting or queueing a fill. Every refusal begins with the
absolute manifest filename and 1-based source line; related declarations
include their own filenames and lines. JSON and YAML locations are retained.
No accepted run may silently have zero work for a selected kind.

- Missing/empty produces: `plugin.json:line: plugin NAME declares no output; declare produces, including Problem records for checks`.
- Unknown kind/input: `file:line: KIND is not a declared kind in produces, reads or derives-from`.
- Invalid field: `file:line: plugin NAME names undeclared field KIND.FIELD`.
- Unknown refinement target: `file:line: plugin NAME refines unknown or disabled plugin OTHER`.
- Overlapping unordered writers: `file:line: plugins A and B both produce KIND.FIELD without a refinement relation; declare which refines which or disable one; other declaration OTHERFILE:line`.
- Cycle: `file:line: fill declarations form a cycle: A -> B -> A`.
- Invalid concurrency: `file:line: plugin NAME concurrency must be a positive integer`.
- Missing runnable producer: `file:line: selected kind KIND has no enabled producer; enable its producer`.
- Missing required agent: `file:line: plugin NAME requested an agent but none is selected; choose --agent or select one in the wiki`.
- Invalid cap: `file:line: token cap must be a positive integer`.

## Ordering, facts and selection

Expand kind wildcards against the kinds declared by the product in the pinned
manifest. Catalogue-only kinds are not declared outputs. A plugin reading a kind
runs after every producer of that kind, except its own production and producers
explicitly downstream of that reader in the direct or transitive refinement
chain. Reads consume the prerequisite/base opinion, not that reader's own later
refinement. This prevents the ordinary wildcard refiner from creating a reverse
read edge to every base producer. Refinement adds an edge from the refined
producer to the refining producer. Unrelated read cycles and contradictory
refinement declarations remain startup errors. Order follows
only these declarations; ready unrelated plugins may run in parallel subject
to their concurrency limits. Refuse cycles before any plugin is launched.
Two overlapping writers must be comparable in the refinement chain, even if
a read dependency happens to order their execution. Preserve every fact's
plugin source and evidence; the page resolves a field to the last producer in
its declared refinement chain, never arrival time or an engine type ranking.

A wiki or CLI selection contains the requested kinds and their transitive
`derives-from` prerequisites only. Never add kinds that depend on the selected
ones. Both entry points use the same engine selection function and plan.
For a unit produced by plugin P, `derives-from` prerequisites wait for their
base/earlier producer units to complete, including units from other plugins and
prerequisite-kind units produced by P itself. Only the identical current unit
(same plugin and kind) is excluded as self, not another kind's unit of P.
As with `reads`, a producer Q that directly or transitively refines P is not a
prerequisite of P's unit: the derived unit consumes the prerequisite version
available before its own later refinements, rather than waiting for that future
opinion. This is a refinement-chain rule for any plugin, not an agent category
exception. Other prerequisite dependencies remain required; genuine dependency
cycles are refused. Refinement is an intentional second opinion, not a no-output
fallback path.

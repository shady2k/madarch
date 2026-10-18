# Fill stages

Capability: fill-stages

## Purpose

Declaring the fill's stages and deriving the graph they run in. A stage is one
module plus its registration: the capabilities it consumes, the fact kinds it
produces, the ordering it asks for, its configuration schema and defaults, and
how it plans, executes and validates its units. The graph is never written by
hand: it is derived from what the stages declare, and the product's manifest
decides which stages run and within which limits. This is the stage contract of
decisions 0026 and 0027, apart from the wiki's lifecycle stages of decision
0021.

## Requirement: registry — A stage is one module plus its registration

The stage registry shall hold every stage module registered with it and shall
refuse a second registration of one stage id, naming both versions. It shall
refuse, where it is made, an id a product's configuration could never name: a
stage id starts with a letter and carries letters, digits, `.`, `_` or `-`. The
registry shall list its stages in code point order of their ids, whatever the
order they were registered in.

### Scenario: register-once
- Given: a stage module with the id `summary`, version 3, is registered
- When: another module declaring the id `summary`, version 4, is registered too
- Then: the second registration is refused with `the stage "summary" is registered twice (versions 3 and 4): each stage is registered once`

### Scenario: register-bad-id
- Given: a stage module declares the id `bad id`
- When: it is registered
- Then: the registration is refused with `the stage id "bad id" is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"`

### Scenario: register-catalogue
- Given: the stages `summary`, `Claims`, `claims` and `draft` are registered in that order
- When: the registry lists them
- Then: they are listed as `Claims`, `claims`, `draft`, `summary`

## Requirement: graph — The stage graph is derived from the declared capabilities

When the stage graph is derived, a capability of an enabled stage shall draw an
edge from every enabled stage that produces it to the consumer, whether the
consume is required or optional, and the enabled stages shall be ordered so that
every edge runs from an earlier stage to a later one. An optional consume is
ordered by the same rule because it reads what a producer of this run publishes:
a consumer that ran first would find the capability absent where the run was
about to produce it. Ties shall be broken by code point order of the stage ids,
so that the same declarations always give the same graph. A fact kind two stages
produce at different schema versions shall refuse the graph, naming the kind
with both stages and versions: one kind carries one schema version.

### Scenario: derived-order
- Given: `snapshot` produces `file-facts`, `modules` consumes `file-facts` and produces `module-facts`, `summary` consumes `module-facts`, `pages` consumes `module-summaries` and `module-facts`, and `overview` consumes `page-drafts`, with the stages that produce those kinds registered
- When: the graph is derived from an empty product configuration
- Then: the order is `snapshot`, `modules`, `summary`, `pages`, `overview`, and each edge names the capability it serves

### Scenario: derived-twice
- Given: three stages consuming one produced capability
- When: the graph is derived twice from the same registry
- Then: both derivations give the same order and the same edges

### Scenario: plan-not-run
- Given: a stage whose `plan`, `execute` and `validate` would throw if they were called
- When: the graph is derived
- Then: the graph is clean: deriving reads the declarations and the product's configuration, and runs no stage

### Scenario: optional-ordered
- Given: `history` produces `history-facts`, and `summary` reads `history-facts` optionally
- When: the graph is derived
- Then: the order is `history`, `summary`, and the edge `history → summary` names `history-facts`

### Scenario: optional-producer-disabled
- Given: `history` and `crawl` both produce `history-facts`, `summary` reads it optionally, and both producers are disabled
- When: the graph is derived
- Then: the graph is clean, holding `summary` alone and no edge for `history-facts`

### Scenario: kind-schema-version
- Given: `index` produces `file-facts` at schema version 2 and `crawl` produces `file-facts` at schema version 1
- When: the graph is derived
- Then: the graph is refused with `the fact kind "file-facts" is produced at schema versions 1 and 2 (by crawl at 1, index at 2): one kind carries one schema version`

## Requirement: order — An `after` adds an ordering beside the capabilities

Where a stage declares `after`, the graph shall order it after each of those
stages that runs, drawing an edge that names the ordering. A pair already
ordered by a capability shall be drawn once, and a capability a stage requires
twice shall draw one edge. If an `after` names a stage the registry does not
hold, or the stage itself, then the derivation shall refuse the graph, naming
the stage and the declared field.

### Scenario: after-edge
- Given: `summary` consumes `module-facts` and declares `after: [modules, snapshot]`, and `snapshot` produces nothing `summary` needs
- When: the graph is derived
- Then: the graph holds `modules → summary` for `module-facts` and `snapshot → summary` for `after`, once each

### Scenario: after-unknown
- Given: the stage `pages` declares `after: [overveiw]`, and no stage has that id
- When: the graph is derived
- Then: the graph is refused, naming the stage, the path `after[0]` and the unknown id

### Scenario: after-self
- Given: the stage `pages` declares `after: [pages]`
- When: the graph is derived
- Then: the graph is refused, naming that a stage cannot run after itself

## Requirement: configuration — The product's manifest enables, disables and limits a stage

The product's configuration file `workspace.yaml` shall configure each stage
under `fill.stages`, keyed by the stage's id, with `enabled`, `concurrency`,
`limits` and the stage's own `config`. A stage the product disables shall leave
the stage graph and nothing shall be ordered through it. Limits the product
writes shall ride over the stage's defaults, the rest kept. A stage shall
declare its own default configuration, `{}` where it has nothing to configure,
and the stage's own `config` shall be judged against the stage's `configSchema`
whether the product wrote one or that default stands: a stage planned with a
value its own schema refuses fails far from the manifest its author edited.
Every fault shall be reported in one answer: a fault of an entry shall name the
manifest's full path, the 1-based line of the field the fault is about and the
field's path, the `config` field's own line included where the fault is about
the field's whole value; a fault of a value the stage's own default carries,
and a fault of a stage's declaration, shall name the stage and the declared
field, since no manifest is to blame for what a module brought itself. A field, a limit
name or a stage id this madarch does not know shall be read past, never
refused — an entry for a stage this madarch does not hold is neither judged nor
planned — so a product's configuration written for a later madarch still opens.

### Scenario: disabled-stage
- Given: a product whose manifest says `fill.stages.overview.enabled: false`
- When: the graph is derived
- Then: `overview` is absent from the order and no edge starts or ends at it

### Scenario: limits-override
- Given: a product whose manifest says `fill.stages.modules.limits.maxTurns: 12`
- When: the stage's configuration is resolved
- Then: `maxTurns` is 12 and the other limits keep the decision's numbers: 272K tokens, wrap at 70%, stop at 80%, 10 minutes and 16K output

### Scenario: refusal-lines
- Given: a manifest saying `fill.stages.snapshot.enabled: maybe` on line 7
- When: the graph is derived
- Then: the refusal names the manifest's full path, line 7, the path `fill.stages.snapshot.enabled` and that the field is true or false

### Scenario: unknown-field
- Given: a manifest naming an unknown limit `maxParagraphs` and an unknown field `retention` on a stage the registry holds
- When: the graph is derived
- Then: it reads cleanly, with the known fields kept and the unknown ones left out

### Scenario: unknown-stage
- Given: a manifest naming a stage the registry does not hold, whose entry is malformed, `concurrency: auto`
- When: the graph is derived
- Then: it reads cleanly and that stage is not in the graph

### Scenario: config-field-line
- Given: the stage `summary`'s entry stands on line 6 with `enabled`, `concurrency`, `limits` and `after` between it and a `config` field on line 12, and the configuration written there lacks `maxDepth`
- When: the graph is derived
- Then: the refusal names line 12, the `config` field's own line, and the path `fill.stages.summary.config`

### Scenario: every-fault
- Given: `a` and `b` require each other's capability, `hungry` requires `ghost-facts` that no stage produces, `tuned` declares `after: [nowhere]` and its entry writes `concurrency: 0`
- When: the graph is derived
- Then: one refusal carries the cycle `a → b → a`, the starvation `hungry → ghost-facts → no producer`, the declaration fault at `after[0]` and the configuration fault at `fill.stages.tuned.concurrency` on its own line

### Scenario: root-not-a-mapping
- Given: a manifest whose whole text is `just-a-word`
- When: the configuration is read
- Then: the refusal names the manifest's full path, line 1 and that a manifest is a mapping of fields

### Scenario: config-default-refused
- Given: the stage `tuned` declares the configuration schema requiring `maxDepth` of 1 or more and its defaults carry `config: {}`, and the product's entry for it says only `concurrency: 2`
- When: the graph is derived
- Then: the graph is refused with the stage `tuned`, the path `defaults.config` and `must have required properties maxDepth; the product's fill.stages.tuned.config replaces the stage's default`, and the same refusal stands where the product writes no entry for `tuned` at all

### Scenario: config-written-null
- Given: the stage `summary` declares a default configuration its schema accepts, and the product writes `config:` with nothing after it on line 7
- When: the graph is derived
- Then: the graph is refused, naming the manifest's full path, line 7, the path `fill.stages.summary.config` and that it must be object: a written value is judged as written, never replaced by the default

### Scenario: config-schema
- Given: the stage `summary` declares a configuration schema requiring `maxDepth` of 1 or more, and the product writes `maxDepth: 0` on line 8
- When: the graph is derived
- Then: the graph is refused, naming the manifest's full path, line 8, the path `fill.stages.summary.config.maxDepth`

## Requirement: starvation — A required capability no enabled stage produces is named by its path

If a required capability of an enabled stage has no enabled producer, then the
derivation shall refuse the graph and report the exact path
consumer → capability → producer, saying whether no stage produces the
capability at all or every producer of it is disabled. An optional capability
nothing enabled produces shall not starve a stage and shall draw no edge, while
an optional capability an enabled stage produces shall order the consumer after
that producer; a stage that produces the capability it consumes shall satisfy
itself: the other producers of it being disabled starves nothing. "A producer found nothing" shall not be a starvation
either: it is a plan's own answer, and deriving a graph runs no plan.

### Scenario: producer-disabled
- Given: `modules` requires `file-facts`, `snapshot` produces it, and the product disables `snapshot`
- When: the graph is derived
- Then: the refusal names `modules → file-facts → snapshot (disabled)`

### Scenario: no-producer
- Given: `modules` requires `model-facts` and no registered stage produces it
- When: the graph is derived
- Then: the refusal names `modules → model-facts → no producer`

### Scenario: every-producer-disabled
- Given: `index` and `crawl` both produce `file-facts` and the product disables both
- When: the graph is derived
- Then: the refusal names both paths, `modules → file-facts → crawl (disabled)` and `modules → file-facts → index (disabled)`

### Scenario: self-producer
- Given: `history` produces `history-facts` and requires it, and `crawl` produces it too and is disabled
- When: the graph is derived
- Then: the graph is clean, holding `history` alone

## Requirement: cycle — A cycle of the derived graph is refused, naming it

If the derived edges hold a cycle, then the derivation shall refuse the graph
and name the cycle as a path whose first and last stage are the same. A stage
that consumes the capability it produces shall not be its own producer, so it
does not wait for itself, and a disabled stage shall break a cycle instead of
closing it.

### Scenario: capability-cycle
- Given: `refine` consumes `module-facts` and produces `refined-facts`, and `cluster` consumes `refined-facts` and produces `module-facts`
- When: the graph is derived
- Then: the refusal names the cycle `cluster → refine → cluster`

### Scenario: after-cycle
- Given: `pages` orders itself after `overview` and `overview` after `pages`
- When: the graph is derived
- Then: the refusal names the cycle `overview → pages → overview`

### Scenario: disabled-breaks-cycle
- Given: two stages that need each other's capability, one of them disabled
- When: the graph is derived
- Then: no cycle is reported, and the disabled producer starves the consumer by its path

## Requirement: snapshot — A run snapshots the configuration it resolved

A run shall be able to snapshot every stage's resolved configuration and
version as one canonical digest, so that the inputs of a publication can be
compared later. The digest shall be canonical in what was resolved: the same
configurations held in another order shall give the same digest, and one
configuration written in another key order shall give the same digest too. Two
derivations from the same configuration shall give the same digest, and a
configuration the product changed shall give another.

### Scenario: snapshot-order
- Given: a derived graph's resolved configurations
- When: the same configurations are digested in the reverse order
- Then: the digest is the same one

### Scenario: snapshot-key-order
- Given: two manifests writing one stage's configuration with `maxDepth` and `mode` in the two different orders
- When: both resolved configurations are digested
- Then: the digests are the same, and one with another `mode` value differs

### Scenario: snapshot-digest
- Given: the same registry, once with `modules` at its default limits and once with `maxTurns: 12`
- When: both resolved configurations are digested
- Then: the digest is stable for the defaults and differs for the changed one

## Quality requirements

- **Performance and scale:** deriving the graph is a walk over the registered
  stages and their declared capabilities, and reads one file: the product's
  manifest. No stage's `plan`, `execute` or `validate` is called by it.
- **Reliability and recovery:** the derivation is pure: the same registry and
  the same configuration give the same graph, order, edges and digest on every
  call, and nothing reads the clock, the network or a stage's output.
- **Security and data protection:** the manifest is read, never written. A
  stage's own configuration reaches the stage only through its resolved
  configuration.
- **Data:** the configuration the product wrote and the stages' declared
  defaults are the only inputs; a run's snapshot is a digest of what it
  resolved, kept with the run, not here.
- **Usability and accessibility:** a fault of a configuration entry names the
  manifest's full path, the line and the field's path, and every fault of one
  file is reported at once; a fault of a declaration names the stage and the
  declared field, since a declaration is a module and not a file of the
  product.
- **Compatibility and operation:** a field, a limit name or a stage id this
  madarch does not know is read past, so a configuration written for a later
  madarch still opens; a stage this madarch does not hold is neither judged nor
  planned.

## Context

Decisions 0026 (the graph-first fill) and 0027 (the orchestrator the fill runs
on) fix the stage contract: the registry, the derived DAG, the starvation
diagnostic and the product's `fill.stages` configuration. The configuration
file is the product's manifest, `workspace.yaml` (decision 0021).

## Coverage limits

- Only fake stages exist today: the fill's own stages (the deterministic
  stages 0–7 and the agent stages 8–13 of decision 0026) are not declared here.
- Planning a stage's units, executing one and validating a draft are declared
  by the stage contract and not exercised by this capability: the orchestrator
  (madarch-tzte.19.5) and the crash-injection suite (madarch-tzte.19.6) own them.
- A consume's `scope` and `freshness` and a produce's `scope` are declared and
  not judged by derivation: they say what a publication replaces and what it
  rechecks, which is the orchestrator's publication step (madarch-tzte.19.5).

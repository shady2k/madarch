# Fill history plugin

Capability: fill-history

## Purpose

Read repository history into the product graph through the ordinary git plugin.
Disk supplies repository information and a pinned revision through declared
outputs; git reads those outputs and publishes history through the same opinion
path as any other plugin. There is no native history graph-producing stage.

## Requirement: stage — History is an ordinary declared plugin

The fill shall obtain commits, authors and history from the ordinary git
plugin, whose output entries name their fields, reads, refinements and configuration.
Plugin execution shall interpret Git; the engine shall only schedule, host and
publish the plugin's output. The git plugin shall not require an agent.

### Scenario: registered
- Given: a starter product's plugin declarations
- When: its fill is planned
- Then: git is an ordinary producer following disk through declared reads, not a native history stage

### Scenario: output-scopes
- Given: Commits and Authors are selected from one product
- When: git runs
- Then: plugin-and-kind units enforce their selected fields and own reads, wait for successful prerequisites and report explicit outcomes; neither may write unselected output

## Requirement: ancestry — The pinned ancestry supplies history

The git plugin shall read history at the repository's pinned commit, not the
working tree or the current branch. Commit records shall retain their identity,
parents, author and committer information, message and changed repository paths.
Merge handling and path ordering shall be deterministic. Facts shall identify
their plugin source and evidence rather than carrying a checkout's absolute
path as repository data.

### Scenario: pinned-ancestry
- Given: disk output identifies a repository at a pinned commit and the checkout has a different branch or dirty files
- When: git interprets its history
- Then: the published history is the pinned ancestry and is not changed by the working tree

### Scenario: commit-details
- Given: a fixture history with a root, a child and a merge
- When: git publishes it
- Then: identities, parents, times, author, message and changed paths match the pinned commits

## Requirement: task-keys — History retains declared task-trailer links

The product's configured task trailer shall determine which task keys are
linked from commits. Only the declared trailer shall supply these links, and
repeated keys shall not create duplicate links. A product without a configured
trailer shall not acquire guessed task links.

### Scenario: declared-trailer
- Given: a configured task trailer and a commit with repeated keys in that trailer and unrelated message text
- When: git publishes the history
- Then: each declared task key is linked once and unrelated text creates no link

## Requirement: incremental — Reruns retain equivalent published history

A rerun shall not create duplicate commits, authors or task links. Published
identity and content shall remain stable when the pinned ancestry is unchanged.
A new commit shall extend the history without losing unchanged earlier data;
changed coverage or newly reachable shallow ancestry shall update the affected
history rather than preserving a stale incomplete answer.

### Scenario: unchanged-rerun
- Given: published history for a pinned repository
- When: that history is filled again unchanged
- Then: entities and links retain their identity and no duplicates appear

### Scenario: extended-history
- Given: a new pinned commit extending an already published ancestry
- When: git fills it
- Then: the new commit appears and earlier history remains readable without duplicates

## Requirement: bound — A configured bound is visible in coverage

History reading shall respect its configured depth. When the bound cuts off
reachable history, published coverage shall name that limitation. Reaching the
natural root shall not claim an artificial depth gap. Existing timeout and
performance bounds shall not be increased by this migration.

### Scenario: bounded-history
- Given: a configured depth smaller than the fixture ancestry
- When: git reads it
- Then: the bounded records are published and coverage says where and why the read was cut

## Requirement: gaps — Unreachable history is not silently whole

A shallow boundary or unreadable parent shall be reflected in coverage. A read
that cannot interpret its input shall fail with an actionable repository and
operation description, not silently publish a shorter history as complete.
Boundary changed paths shall be Git's answer for the available ancestry; when
parents become reachable, a rerun shall refresh the affected records.

### Scenario: shallow-boundary
- Given: a shallow fixture repository
- When: git fills history
- Then: coverage names the boundary and does not describe the shorter ancestry as complete

### Scenario: newly-reachable-parent
- Given: earlier coverage named an unreachable parent that is now available
- When: git runs again
- Then: history and coverage reflect the newly reachable ancestry

## Requirement: reads — Disk opinions are declared inputs, publication is generic

Git shall read the repository information disk publishes through declared
`reads`, and any held opinions through generic plugin read facilities. Generic
host facilities may carry a pinned revision or provide confined repository
access, but shall not interpret the tree or Git history into graph facts.
Publication and readback shall retain source/evidence through ordinary typed
opinions. No reader shall require a hardcoded native history-kind exception, native alias
or fallback. Canonical `code.*` kinds and declared relations retain every
existing typed field, source/evidence and retained run/version history.

### Scenario: disk-before-git
- Given: disk produces repository information that git declares as input
- When: Commits is selected
- Then: disk publishes before git reads that information and no native snapshot/history stage supplies an alternative input

### Scenario: generic-readback
- Given: git published commits, authors and history
- When: lists, counts, entity lookup and history are read
- Then: generic readers expose those opinions with their source and evidence

## Quality requirements

- **Performance and scale:** preserve bounded history reads and measure the same training workload before and after migration under unchanged bounds.
- **Reliability and recovery:** publication uses ordinary plugin draft/publication semantics; failure does not leave a partially published plugin result.
- **Security and data protection:** repository access remains confined; Git executes as a program, not shell text, and loader variables do not redirect it to another checkout.
- **Data:** pinned commit objects, not dirty working-tree data, supply history; plugin opinions retain source/evidence.
- **Usability and accessibility:** failures name the repository and operation, and coverage distinguishes incomplete history from complete history.
- **Compatibility and operation:** git is shipped by the starter and uses ordinary plugin declarations, selection and readback, without native-kind exceptions.

## Context

This proposal replaces the native stage lifecycle and native snapshot/fact SQL
contract of the accepted fill-history capability. Its history, task-link,
bounding, gap and rerun behaviors remain required through the ordinary plugin
path. All twelve madarch-64o5.28 contract rules remain normative; this integration
does not replace their per-output units, reads, scope enforcement, successful
dependency gating or outcome/publication lifecycle. Historical evidence remains
unchanged. Generic read-only pinned inputs and declared tool rights supply access,
not a native interpreter. Native history stages and writers must be deleted.

## Coverage limits

Evidence is pending. Fixture regressions and focused history tests must verify
the preserved behavior; the migration does not itself establish a green check.
No real agent or model may be invoked to demonstrate these deterministic paths.

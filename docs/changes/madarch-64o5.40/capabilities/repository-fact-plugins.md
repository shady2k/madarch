# Repository fact plugins

Capability: repository-fact-plugins

## Purpose

Populate repository facts through ordinary declared plugins rather than native
repository-tree and history stages. The engine supplies the generic plugin
host, scheduling and publication; only plugins interpret the repository tree
and Git records to produce graph data.

## Requirement: producers — The starter ships ordinary disk and git plugins

A fresh starter shall ship ordinary disk and git plugins with nonempty
`produces` and declared `reads`. Disk shall interpret repository contents and
produce repositories, files and folders through output-specific entries.
Git shall read disk output and interpret Git to produce commits, authors and
history through output-specific entries. Neither producer shall require an
agent. Units remain plugin-and-kind scoped under .28 contract rules 5–12;
multiple output entries retain one ordinary plugin identity, not unrestricted
permission to publish every output. Each entry owns fields, reads and refines.

### Scenario: fresh-starter
- Given: a product initialized from the starter
- When: its enabled plugin declarations are loaded
- Then: disk declares repository, file and folder outputs and git declares commit, author and history outputs with its disk-output reads

### Scenario: scoped-disk
- Given: Files is selected and disk produces Files, Folders and Repositories
- When: disk runs
- Then: only selected prerequisite-closure units run, each restricted to its declared selected kind/fields; unselected writes fail

### Scenario: scoped-git
- Given: Commits is selected and git produces Commits, Authors and history
- When: git runs
- Then: each selected git unit waits for its required successful producers, enforces its own reads/fields and reports its own outcome

## Requirement: selection — Declarations select and order deterministic producers

The selected producer closure shall follow the product's kind prerequisites and
plugins' declared reads and outputs. Git's `code.file` key output refines disk's
key output so historical files retain ordinary identity. Files requesting latest
keys shall therefore select the required disk/git closure, as shall Commits. No numeric stage order, producer category or native
kind exception shall supply this relation. Missing enabled producers shall be
refused before acceptance, not replaced with native work. The existing rules
for a genuinely selected plugin that requests an agent remain in force.

### Scenario: files-latest-keys
- Given: a starter product with disk and git enabled
- When: Files is selected
- Then: the plan includes required disk/git units because git refines current file keys, preserves historical file identities and requires no agent

### Scenario: commits-after-disk
- Given: a starter product whose git declaration reads disk's output
- When: Commits is selected
- Then: disk's execution and publication complete before git consumes them, without either producer requesting an agent

### Scenario: declared-order-not-name
- Given: equivalent fixture plugins with different identifiers and the same declared input/output relationship
- When: their output is selected
- Then: the reader follows the producer through the declarations, without a hardcoded disk/git name check

### Scenario: missing-disk
- Given: git needs disk output and no enabled plugin produces it
- When: Commits is requested
- Then: admission refuses with the missing producer path before queueing, and no native tree reader fills the gap

## Requirement: publication — Repository opinions use generic publication and readers

Plugins shall publish canonical `code.repository`, `code.directory`, `code.file`,
`code.gitlink`, `code.commit` and `code.author` facts and declared relations with
all existing fields, source, evidence and run/version history through the ordinary
plugin opinion path. List, count, lookup and history readers shall read the
published data using declared kind metadata, not a native-kind exception. The
engine shall contain no repository tree walk or Git-history interpretation that
feeds repository facts into the graph outside plugins. Generic host transport,
confinement and repository access do not authorize engine-side interpretation.
Identity keys are ordinary declared scalar values: file/directory/gitlink
repository and path, repository name, commit hash, author name/email; no native
nested-reference or physical-node alias supplies identity.
Only generic read-only pinned input and declared trusted executable/tool rights are
available to plugins; repository-specific host interpretation is not a substitute
for real disk/git plugin code. Native stages and graph writers are deleted, not
left disabled or exposed through native read/write aliases.

### Scenario: generic-readback
- Given: disk and git published repository, file, folder, commit, author and history data
- When: the corresponding kind lists, counts, entity lookup and history are read
- Then: they show the published opinions and their source/evidence through generic readers

### Scenario: no-native-producer
- Given: no repository producer plugin is enabled
- When: fill planning and execution run
- Then: native repository-tree or history stages do not walk the repository, interpret Git or populate graph facts

### Scenario: field-and-history-preservation
- Given: populated repository and history fixtures with all existing typed fields and evidence
- When: ordinary plugin publication and readers replace the native path
- Then: identities, fields, relations, source/evidence and retained versions remain available without native aliases or fallback

## Requirement: regression — Fixture evidence and the same workload protect behavior

Tests shall use held or generated fixture repositories and scripted adapters;
no real agent or model shall run. Acceptance shall include red-first regression
evidence and the same training-workload speed measurement before and after the
change. Existing timeout and performance bounds shall not be increased to make
the migration pass. Missing evidence or a failed check shall be reported, not
relabelled as passed.

All twelve rules in `../../madarch-64o5.28/contract.md` remain normative,
including per-output prerequisite validation, immutable explicit earlier reads,
success-gated dependencies, scoped replacement/retraction, authored-input plugins
and explicit per-kind outcomes. No native exemption satisfies any rule.
A coordinator-reported actual internal-native baseline is recorded in change.md;
whole-suite green, after timing and comparable before/after analysis remain pending;
only the parent coordinator runs checks and PostgreSQL commands.


Schema migration revision is 5 → 6. The release-platform trusted Git digest is
`eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201`.


### Scenario: fixture-fill
- Given: a generated repository with known paths and commits
- When: disk and git fill the selected kinds
- Then: the declared outputs match that repository and no real agent or model is contacted

### Scenario: comparable-speed
- Given: the same training fixture, commands and execution settings before and after migration
- When: fill speed is measured
- Then: both actual measurements and their inputs are reported under unchanged bounds

### Scenario: historical-file-identity
- Given: a historical changed path absent from the pinned tree and git declaring a `code.file` key refinement of disk
- When: history and latest file keys are filled
- Then: ordinary declared publication preserves that file identity without an `ensureVertex` exception, native writer or hidden prerequisite exemption



## Requirement: partitions — Large outputs use generic bounded key plans

An output may declare `partition: "key"` and enumerate a complete bounded key
plan through the generic host SDK protocol. The host shall validate exact keys,
reject duplicate keys and include prior producer keys needed for deletions.
Every partition draft is confined to its declared key and selected kind/fields.
The 8 MiB per-execution-unit and 1 MiB per-message limits remain unchanged.
Facts, fields and evidence shall not be omitted, and compression shall not
bypass a cap. This protocol is ordinary plugin infrastructure available to all
large outputs; it has no native or repository-specific exemption.

Only a whole successful output barrier may publish. Generic graph publication
shall atomically aggregate immutable generation references after all partitions
succeed. Partial/failed/abstained work retains prior successful facts and blocks
consumers. Producer-scoped deletion/replacement and retained history apply to
the complete selected output. Explicit named earlier reads shall identify only
a successful complete immutable barrier generation.

Contract approved for implementation; runtime implementation and validation are
pending. Actual oversized glossary evidence and partial checks remain recorded
in change.md; this design does not itself establish acceptance.

### Scenario: bounded-complete-output
- Given: an ordinary output exceeding one 8 MiB execution unit and opting into key partitioning
- When: its complete validated plan executes within unchanged unit/message caps
- Then: all facts/fields/evidence publish atomically only after all partitions succeed

### Scenario: failed-partition
- Given: a validated complete plan with prior producer keys including deleted keys
- When: one partition fails or abstains
- Then: no partial output publishes, previous successful facts remain and consumers stay blocked

### Scenario: invalid-key-plan
- Given: a partition declaration and a key plan with duplicate, unexpected or missing required prior keys
- When: the host validates it
- Then: refuse the invalid plan rather than accept partial enumeration or silently lose facts


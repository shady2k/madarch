# Selective plugin fill

Capability: selective-plugin-fill

## Purpose

Run every selected kind through its declared producers with the selected agent
and token cap available to every plugin. This uses the declaration, ordering and
prerequisite selection contract of madarch-64o5.28, without plugin categories.

## Requirement: execution — Every selected kind reaches its declared producers

Selective fill shall execute the plugins producing every selected kind and its
prerequisites. The general agent plugin is available for every kind, but its ordinary
unclaimed declarations schedule only fields without configured producer claims.
Explicit kind/field configuration enables overlapping named refinement. The server shall validate that work is runnable before accepting a
request; an accepted run must not silently skip a selected kind. Tests use a
scripted fixture, never a real agent or model.

### Scenario: general-producer
- Given: a selected Page templates kind has no dedicated producer and a scripted agent is selected
- When: its selective fill runs
- Then: the general agent plugin fills it rather than returning success with no work

### Scenario: producer-and-refiner
- Given: a selected kind has a dedicated producer and explicit general-agent field/refinement configuration
- When: its selective fill runs
- Then: the dedicated producer runs before the general agent refinement under the declared ordering

### Scenario: refuse-before-acceptance
- Given: the selected kind's producer needs an agent but none is selected
- When: the server receives the fill request
- Then: it refuses before accepting, queueing or starting work, naming the requesting plugin's absolute manifest filename and 1-based source line and how to choose an agent in the wiki or with --agent

### Scenario: disabled-or-omitted-plugin-stage
- Given: selected-kind declarations have producers but the runnable plugin stage is disabled or omitted from the run graph
- When: the server receives the selective fill request
- Then: it refuses before HTTP 202 and before queueing rather than accepting work that cannot execute

### Scenario: cross-plugin-prerequisite-completion
- Given: a selected kind derives from another kind produced by a different plugin
- When: their selective fill runs
- Then: required prerequisite-kind producer units complete successfully before the derived-kind unit starts, including across plugin boundaries; earlier-version consumption requires an explicit named producer snapshot, never an implicit refinement exemption

## Requirement: run-options — Any plugin can request the chosen agent and cap

The wiki shall offer an agent selector and optional positive whole-number token
cap, enabled when a run is not busy or disabled. The CLI shall expose `--agent`
and `--token-cap` with `--entity`. Both entry points pass those values through
the fill run to the host agent service for any plugin that requests it. Plugin
identity or category shall not decide who receives the values. An invalid cap
shall be refused rather than silently changed.

### Scenario: wiki-inputs
- Given: an idle fill page and the Scripted agent fixture
- When: a person chooses that agent and a positive token cap and presses Run
- Then: the fill request carries the selected kinds, chosen agent and cap

### Scenario: busy-controls
- Given: a fill run is busy
- When: its setup controls are shown
- Then: agent and token-cap controls are locked until another run may be started

### Scenario: cli-inputs
- Given: a CLI caller selecting a kind
- When: they read madarch fill --help
- Then: it offers --agent and --token-cap and describes prerequisites only, not dependant kinds

### Scenario: plugin-agent-service
- Given: an enabled plugin requests the host agent service during selective fill
- When: the scripted fixture receives its call
- Then: the call uses the chosen agent and token cap regardless of the plugin's name

### Scenario: invalid-cap
- Given: a supplied token cap is zero, negative or not a whole number
- When: a fill is requested
- Then: validation refuses it as requiring a positive integer before work starts

## Requirement: conditional-agent — Only a plan requesting an agent requires selection

The plan shall use the product's enabled plugins. Agent selection shall be
required only when a planned plugin requests it. The idle wiki shall mark the
agent field required for that plan and keep Run disabled with a visible,
actionable reason while the selection is missing. It shall offer no no-agent
option and create no waiting-for-agent state. A product enabling only
deterministic plugins shall be runnable without agent selection. The server
shall enforce the same condition before accepting, queueing or starting work,
with the requesting plugin's absolute manifest filename, 1-based source line
and how to choose an agent. Fixtures shall declare only exercised plugins,
retain valid kinds and typed fields, and use scripted agents for exercised
agent requests, never real agents or models.

### Scenario: required-selection-disabled-run
- Given: an idle fill page whose enabled planned plugin requests an agent and no agent is selected
- When: setup controls are shown
- Then: the agent field is required, Run is disabled with a reason explaining how to choose an agent, and no no-agent option is offered

### Scenario: deterministic-only-run
- Given: a product enables only deterministic plugins for the selected kind and prerequisites and no agent is selected
- When: the wiki previews the plan and the server receives its fill request
- Then: the agent field is not required, the missing selection does not disable Run, and the server can start the declared work without an agent

### Scenario: scripted-fixture-only
- Given: a fixture declares only the plugins it exercises and retains valid kinds and typed fields
- When: the exercised plugin requests an agent
- Then: the test selects a scripted agent without invoking a real agent or model or weakening declarations to mask failures

## Requirement: named-producers — Catalogue and fill setup show plugin names

The catalogue, kind details and fill setup shall name declared producer plugins,
including general-agent as an ordinary plugin. They shall not label plugins as
own handlers, agent versus code extraction, or person categories, nor claim that
selective fill supports only own handlers. The wiki preview uses the same
prerequisite-only closure as the engine and CLI; selecting a kind never selects
its dependants. Server validation remains authoritative for runnable work.

### Scenario: producer-names
- Given: a kind with dedicated and general-agent producer declarations
- When: its catalogue entry, details or fill setup is read
- Then: the declared plugin names appear without an agent or own-handler category

### Scenario: preview-prerequisites
- Given: summary derives from source and report derives from summary
- When: summary is selected on the fill page
- Then: its preview selects source and summary but not report, matching CLI selection

## Quality requirements

- Validation precedes run acceptance so missing producers or agents cannot create silent no-op success.
- Existing UI-kit controls and named links are reused; count links keep their numeral and destination title.
- Scripted fixtures exercise agent requests without spending real model tokens.

## Required lifecycle and access behavior

The twelve normative rules and eight review regression scenarios in
`../../madarch-64o5.28/contract.md` apply to this execution path. Invocation
outputs are restricted to selected declared kinds/fields. Catalogue and agent
reads are restricted per output. Forbidden accesses fail; catalogue permission
does not bypass scope. Authored prerequisites can be satisfied by ordinary
successful input plugins. Outcomes are completed, unchanged, empty, abstained
or failed per plugin/kind, with current run/version linkage; zero Problems is
successful empty output. Successful authoritative scope replacement retracts
old producer opinions; failed/abstained work retains previous good facts without
claiming they are current. Required consumers start only after upstream success.

### Scenario: no-compulsory-agent
- Given: configured deterministic producers cover all selected fields and general-agent capability is available
- When: setup previews the expanded plan
- Then: no agent request is scheduled and selection is not required merely for capability availability

### Scenario: output-scope-is-enforced
- Given: a plugin can produce Files and Summaries but only Files is selected
- When: it attempts a Summary emission
- Then: the invocation fails with scope context rather than writing unselected output

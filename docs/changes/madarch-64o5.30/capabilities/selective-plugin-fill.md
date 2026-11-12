# Selective plugin fill

Capability: selective-plugin-fill

## Purpose

Run every selected kind through its declared producers with the selected agent
and token cap available to every plugin. This uses the declaration, ordering and
prerequisite selection contract of madarch-64o5.28, without plugin categories.

## Requirement: execution — Every selected kind reaches its declared producers

Selective fill shall execute the plugins producing every selected kind and its
prerequisites. The general agent plugin is an ordinary wildcard producer that
refines the other producers and fills a kind with no dedicated producer from its
description. The server shall validate that work is runnable before accepting a
request; an accepted run must not silently skip a selected kind. Tests use a
scripted fixture, never a real agent or model.

### Scenario: general-producer
- Given: a selected Page templates kind has no dedicated producer and a scripted agent is selected
- When: its selective fill runs
- Then: the general agent plugin fills it rather than returning success with no work

### Scenario: producer-and-refiner
- Given: a selected kind has a dedicated producer and the general agent plugin enabled
- When: its selective fill runs
- Then: the dedicated producer runs before the general agent refinement under the declared ordering

### Scenario: refuse-before-acceptance
- Given: the selected kind's producer needs an agent but none is selected
- When: the server receives the fill request
- Then: it refuses with an actionable reason before accepting or queueing the run

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

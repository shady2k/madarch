# Catalogue value-type conversion — madarch-64o5.138

## Scope and result

Decision 0039 items 3, 4 and 29: 596 kind fields plus 10 edge attribute fields name installed shared value types. All 127 JSON kind fields declare `$schema: https://json-schema.org/draft/2020-12/schema` and an explicit `$ref`. There are no JSON edge attributes. The library contains 63 schemas with immutable `urn:madarch:value-type:<name>:v1` IDs. No new repository data files were introduced. Existing catalogue kind files and catalog/catalog.yaml carry the declarations.

92 kind YAML files changed, plus catalog/catalog.yaml. Additional code edit: src/knowledge/catalog-starter.ts widens ContractFieldData.type to string and preserves schema in its type. Runtime compatibility views already retain raw fields, schema and the full metadata library. src/knowledge/seed.ts needs no change: raw kind files and the spread catalogue metadata retain the library for starter selections.

## Counts by assigned type

| Type | Kind fields | Edge fields | Total |
| --- | ---: | ---: | ---: |
| bigint | 3 | 0 | 3 |
| boolean | 20 | 1 | 21 |
| class-diagram-level | 1 | 0 | 1 |
| duration-ms | 1 | 0 | 1 |
| duration-seconds | 3 | 0 | 3 |
| email | 2 | 0 | 2 |
| integer | 26 | 0 | 26 |
| json | 127 | 0 | 127 |
| path | 23 | 0 | 23 |
| port | 3 | 0 | 3 |
| text | 347 | 7 | 354 |
| timestamp | 33 | 2 | 35 |
| url | 1 | 0 | 1 |
| value-set-value | 1 | 0 | 1 |
| version | 5 | 0 | 5 |

## Producer evidence and explicit assumptions

- Disk producer: plugins/disk/main.ts:27 emits `languages` from reader candidates; plugins/disk/reader.ts:18 declares readonly string[]. Its schema is an array of text.
- Database producer: plugins/db-schema/main.ts:864 emits check expressions from Column.checks (string[], line 59); line 869 emits index.columns (readonly string[], line 77). Both schemas are arrays of text.
- Agent-produced fields follow their existing catalogue binding descriptions: ordered arrays of names/conditions/checks; field-set declarations have named typed fields; labels are maps of language to in/out text.
- No implementation exists for the catalogue’s `operations` producer in this checkout. Operations schemas establish the concrete contract from each kind’s declaration, not a claim of observed output. Ports are integer arrays, except Kubernetes service ports (closed port descriptor records). Compose environment is a string/null map. Docker stages are image/name records. CI steps are closed records. Kubernetes probes are closed liveness/readiness/startup maps of path/port/scheme. Lock packages are closed name/version/integrity/resolved/dev records. A future producer must meet these declarations rather than choose a different shape silently.
- CI workflow trigger configuration deliberately allows a declared extension map of scalar/list values, null entries and cron arrays. It does not permit arbitrary nested unvalidated JSON.
- Existing `reference` fields remain present: converting them to edges is a separate task (0039 items 1–2). Their JSON schemas describe their present `{kind, key}` reference objects, with constant kind and required natural-key properties, including nested `{kind, key}` references. This is not completion of the reference-to-edge redesign. Lists such as task.labels still follow the current single reference-key field contract; its cardinality redesign remains edge work.
- Value-set assignments that currently use reference-key objects retain that contract. New `value-set-value` text type applies to the entry’s scalar `value`; the library is not hard-coded to today’s allowed product values. Runtime graph-dependent value-set membership remains outside this catalogue-only work.
- Timestamp fields remain RFC3339 date-time strings; date-only is provided as a reusable separate type, without changing current timestamp storage.
- Duration units were read from bindings: job-run, drill and work-span use duration-seconds; test-result uses duration-ms. Both are nonnegative integer contracts; no values or units were converted.
- Path rejects NUL/CR/LF and empty strings; version rejects whitespace/NUL and empty strings, but allows package constraint syntax without spaces. Money is ISO-style uppercase three-letter currency code, space, signed decimal amount; it is available but no existing cost field was forcibly reinterpreted. Email/URL use Ajv format assertions. IP addresses and ISO duration also use standard formats.
- Existing git-author email now uses email format. Historical malformed git identities will be refused rather than silently accepted; if arbitrary Git identity text is intended, the catalogue should deliberately keep that field text.

## Validation

- Foreground strict Ajv2020 + ajv-formats compile: 63 library schemas and 127 explicit field schemas compiled; 596 kind fields resolved to installed types. Exit 0.
- `bun run check:catalog`: passed, 28 areas, 106 subgroups, 498 kinds, 117 page/member kinds, everything and none templates no findings. Exit 0.
- No agents/fills, commits, background checks or builds were started. Parent handles writer/parser/integration tests and mutation testing; none is claimed here.

## Every JSON field schema

All field schemas below declare Draft 2020-12. The exact schema is shown at each full file/line location. Shared schema bodies follow in code-point order.

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/activity-node.yaml:20 — activity

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-activity:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/activity.yaml:29 — subject

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.symbol:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/process-event.yaml:20 — process

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-business-process:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/process-gateway.yaml:19 — process

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-business-process:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/state-machine.yaml:29 — subject

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-domain-entity:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/state.yaml:20 — machine

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-state-machine:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/transition.yaml:44 — event

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-event:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/transition.yaml:28 — from

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-state:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/transition.yaml:20 — machine

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-state-machine:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/behaviour/transition.yaml:36 — to

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-state:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/class-diagram.yaml:41 — domain

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-domain:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/class-diagram.yaml:32 — module

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.module:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/scenario-step.yaml:32 — from_role

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/scenario-step.yaml:41 — from_service

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.service:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/scenario-step.yaml:20 — scenario

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-runtime-scenario:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/scenario-step.yaml:50 — to_role

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/architecture/description/scenario-step.yaml:59 — to_service

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.service:v1"
}
```

### /tmp/madarch-64o5.138/catalog/automation/process/business-process.yaml:37 — owner

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/automation/process/process-step.yaml:48 — performed_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.service:v1"
}
```

### /tmp/madarch-64o5.138/catalog/automation/process/process-step.yaml:39 — performer

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/automation/process/process-step.yaml:19 — process

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-business-process:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/analysis/code.cycle.yaml:27 — members

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/analysis/code.debt.yaml:24 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/analysis/code.input.yaml:21 — symbol

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.symbol:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/analysis/code.sql-build.yaml:19 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/analysis/code.sql-sink.yaml:22 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.channel.yaml:39 — broker

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.broker:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.contract.yaml:26 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.message.yaml:37 — channel

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.channel:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.message.yaml:22 — contract

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.contract:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.message.yaml:46 — event_types

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.operation.yaml:34 — contract

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.contract:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.route.yaml:51 — handler

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.symbol:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.route.yaml:60 — middleware

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.route.yaml:68 — ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/contracts/code.route.yaml:30 — service

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.service:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.entry-point.yaml:25 — file

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.file:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.entry-point.yaml:33 — symbol

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.symbol:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.field.yaml:24 — symbol

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.symbol:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.file.yaml:109 — languages

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.module.yaml:27 — folder

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.directory:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.service.yaml:55 — frameworks

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.service.yaml:36 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.symbol.yaml:48 — file

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.file:v1"
}
```

### /tmp/madarch-64o5.138/catalog/code/structure/code.symbol.yaml:40 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/attachment/comment.yaml:26 — author

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/field-set.yaml:28 — fields

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:field-set-fields:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/link-type.yaml:27 — from_kinds

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/link-type.yaml:43 — labels

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:link-type-labels:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/link-type.yaml:35 — to_kinds

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/responsibility.yaml:35 — executor

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/responsibility.yaml:21 — responsible

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/schema/workflow.yaml:31 — stages

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/common/values/value-set-entry.yaml:21 — set

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set:v1"
}
```

### /tmp/madarch-64o5.138/catalog/data/model/logical-data-model.yaml:27 — domain

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-domain:v1"
}
```

### /tmp/madarch-64o5.138/catalog/data/storage/code.column.yaml:39 — check

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/data/storage/code.database.yaml:26 — service

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.service:v1"
}
```

### /tmp/madarch-64o5.138/catalog/data/storage/code.index.yaml:31 — columns

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/data/storage/code.migration.yaml:22 — repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.repository:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/build/code.compose-service.yaml:44 — depends_on

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/build/code.compose-service.yaml:52 — environment

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.compose-service-environment:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/build/code.compose-service.yaml:36 — ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/build/code.dockerfile.yaml:36 — exposed_ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/build/code.dockerfile.yaml:28 — stages

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.dockerfile-stages:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/pipeline/code.ci-job.yaml:38 — steps

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.ci-job-steps:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/pipeline/code.ci-job.yaml:46 — uses

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/pipeline/code.ci-workflow.yaml:37 — on

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.ci-workflow-on:v1"
}
```

### /tmp/madarch-64o5.138/catalog/delivery/pipeline/code.make-target.yaml:38 — recipe

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/documentation/document/guide.yaml:27 — audience

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/documentation/feedback/correction.yaml:48 — by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/documentation/feedback/correction.yaml:62 — resolved_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/documentation/feedback/correction.yaml:39 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/infrastructure/orchestration/code.k8s-deployment.yaml:47 — container_ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/infrastructure/orchestration/code.k8s-deployment.yaml:63 — env_from

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/infrastructure/orchestration/code.k8s-deployment.yaml:55 — probes

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.k8s-deployment-probes:v1"
}
```

### /tmp/madarch-64o5.138/catalog/infrastructure/orchestration/code.k8s-service.yaml:32 — ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.k8s-service-ports:v1"
}
```

### /tmp/madarch-64o5.138/catalog/infrastructure/orchestration/code.k8s-service.yaml:40 — selector

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-map:v1"
}
```

### /tmp/madarch-64o5.138/catalog/messaging/messaging/code.broker.yaml:33 — addresses

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/operations/dependencies/code.lockfile.yaml:47 — packages

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:code.lockfile-packages:v1"
}
```

### /tmp/madarch-64o5.138/catalog/operations/observability/code.metric.yaml:48 — labels

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/operations/runtime/code.health-endpoint.yaml:41 — ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/operations/runtime/code.metrics-endpoint.yaml:42 — ports

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:port-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/rd/decision/doc.decision.yaml:76 — decided_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/rd/decision/doc.decision.yaml:37 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/doc.requirement.yaml:40 — priority

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/doc.requirement.yaml:49 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/doc.term.yaml:33 — also_called

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/doc.use-case.yaml:40 — primary_actor

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/use-case-step.yaml:32 — actor

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/use-case-step.yaml:54 — extension_of

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-use-case-step:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/use-case-step.yaml:45 — system_action

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.operation:v1"
}
```

### /tmp/madarch-64o5.138/catalog/requirements/statement/use-case-step.yaml:20 — use_case

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-doc.use-case:v1"
}
```

### /tmp/madarch-64o5.138/catalog/resilience/drill/drill.yaml:27 — objectives_met

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/security/vulnerability/suppression.yaml:39 — by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/strategy/direction/principle.yaml:43 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/strategy/product/product.yaml:35 — audience

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-role:v1"
}
```

### /tmp/madarch-64o5.138/catalog/testing/case/code.test-case.yaml:31 — file

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.file:v1"
}
```

### /tmp/madarch-64o5.138/catalog/testing/case/code.test-quarantine.yaml:45 — latest_result

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-test-result:v1"
}
```

### /tmp/madarch-64o5.138/catalog/testing/case/code.test-quarantine.yaml:27 — test

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.test-case:v1"
}
```

### /tmp/madarch-64o5.138/catalog/testing/defect/defect.yaml:48 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/testing/run/test-result.yaml:20 — test

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.test-case:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/coordination/handoff.yaml:27 — from

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/coordination/handoff.yaml:36 — to

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/coordination/question.yaml:71 — asked_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/coordination/question.yaml:85 — resolved_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/coordination/question.yaml:62 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/execution/task.yaml:86 — labels

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/execution/task.yaml:67 — priority

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/execution/task.yaml:58 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/execution/work-span.yaml:27 — who

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/planning/epic.yaml:47 — priority

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/planning/epic.yaml:38 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/planning/feature.yaml:41 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/planning/milestone.yaml:31 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/planning/stage.yaml:33 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/sync/merge.yaml:43 — commit

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.commit:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/sync/merge.yaml:52 — conditions

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/sync/merge.yaml:34 — merged_by

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-person:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/sync/review-finding.yaml:34 — place

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-code.file:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/code-convention.yaml:48 — paths

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:path-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/code-convention.yaml:56 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/constitution.yaml:41 — precedence

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/constitution.yaml:29 — product

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-product:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/constitution.yaml:49 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/practice.yaml:49 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/skill.yaml:45 — checks

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:text-list:v1"
}
```

### /tmp/madarch-64o5.138/catalog/work/ways/skill.yaml:53 — status

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "urn:madarch:value-type:key-value-set-entry:v1"
}
```

## Shared schema bodies

These are the exact installed declarations; references resolve within this library.

### bigint — storage bigint

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:bigint:v1",
  "anyOf": [
    {
      "type": "integer"
    },
    {
      "type": "string",
      "pattern": "^(0|-?[1-9][0-9]*)$"
    }
  ]
}
```

### boolean — storage boolean

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:boolean:v1",
  "type": "boolean"
}
```

### code.ci-job-steps — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.ci-job-steps:v1",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "env": {
        "$ref": "urn:madarch:value-type:text-map:v1"
      },
      "id": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "if": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "name": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "run": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "shell": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "uses": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "with": {
        "type": "object",
        "additionalProperties": {
          "anyOf": [
            {
              "$ref": "urn:madarch:value-type:text:v1"
            },
            {
              "$ref": "urn:madarch:value-type:number:v1"
            },
            {
              "$ref": "urn:madarch:value-type:boolean:v1"
            }
          ]
        }
      },
      "working-directory": {
        "$ref": "urn:madarch:value-type:path:v1"
      }
    },
    "unevaluatedProperties": false
  }
}
```

### code.ci-workflow-on — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.ci-workflow-on:v1",
  "anyOf": [
    {
      "$ref": "urn:madarch:value-type:text:v1"
    },
    {
      "$ref": "urn:madarch:value-type:text-list:v1"
    },
    {
      "type": "object",
      "additionalProperties": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "additionalProperties": {
              "anyOf": [
                {
                  "$ref": "urn:madarch:value-type:text:v1"
                },
                {
                  "$ref": "urn:madarch:value-type:boolean:v1"
                },
                {
                  "$ref": "urn:madarch:value-type:number:v1"
                },
                {
                  "type": "null"
                },
                {
                  "$ref": "urn:madarch:value-type:text-list:v1"
                }
              ]
            }
          },
          {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "cron": {
                  "$ref": "urn:madarch:value-type:text:v1"
                }
              },
              "required": [
                "cron"
              ],
              "unevaluatedProperties": false
            }
          }
        ]
      }
    }
  ]
}
```

### code.compose-service-environment — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.compose-service-environment:v1",
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      {
        "type": "null"
      }
    ]
  }
}
```

### code.dockerfile-stages — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.dockerfile-stages:v1",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "image": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "name": {
        "$ref": "urn:madarch:value-type:text:v1"
      }
    },
    "required": [
      "image"
    ],
    "unevaluatedProperties": false
  }
}
```

### code.k8s-deployment-probes — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.k8s-deployment-probes:v1",
  "type": "object",
  "properties": {
    "liveness": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "port": {
          "anyOf": [
            {
              "$ref": "urn:madarch:value-type:port:v1"
            },
            {
              "$ref": "urn:madarch:value-type:text:v1"
            }
          ]
        },
        "scheme": {
          "type": "string",
          "enum": [
            "HTTP",
            "HTTPS"
          ]
        }
      },
      "required": [
        "path"
      ],
      "unevaluatedProperties": false
    },
    "readiness": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "port": {
          "anyOf": [
            {
              "$ref": "urn:madarch:value-type:port:v1"
            },
            {
              "$ref": "urn:madarch:value-type:text:v1"
            }
          ]
        },
        "scheme": {
          "type": "string",
          "enum": [
            "HTTP",
            "HTTPS"
          ]
        }
      },
      "required": [
        "path"
      ],
      "unevaluatedProperties": false
    },
    "startup": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "port": {
          "anyOf": [
            {
              "$ref": "urn:madarch:value-type:port:v1"
            },
            {
              "$ref": "urn:madarch:value-type:text:v1"
            }
          ]
        },
        "scheme": {
          "type": "string",
          "enum": [
            "HTTP",
            "HTTPS"
          ]
        }
      },
      "required": [
        "path"
      ],
      "unevaluatedProperties": false
    }
  },
  "unevaluatedProperties": false
}
```

### code.k8s-service-ports — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.k8s-service-ports:v1",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "name": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "nodePort": {
        "$ref": "urn:madarch:value-type:port:v1"
      },
      "port": {
        "$ref": "urn:madarch:value-type:port:v1"
      },
      "protocol": {
        "type": "string",
        "enum": [
          "SCTP",
          "TCP",
          "UDP"
        ]
      },
      "targetPort": {
        "anyOf": [
          {
            "$ref": "urn:madarch:value-type:port:v1"
          },
          {
            "$ref": "urn:madarch:value-type:text:v1"
          }
        ]
      }
    },
    "required": [
      "port"
    ],
    "unevaluatedProperties": false
  }
}
```

### code.lockfile-packages — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:code.lockfile-packages:v1",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "dev": {
        "$ref": "urn:madarch:value-type:boolean:v1"
      },
      "integrity": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "name": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "resolved": {
        "$ref": "urn:madarch:value-type:url:v1"
      },
      "version": {
        "$ref": "urn:madarch:value-type:version:v1"
      }
    },
    "required": [
      "name",
      "version"
    ],
    "unevaluatedProperties": false
  }
}
```

### date — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:date:v1",
  "type": "string",
  "format": "date"
}
```

### duration — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:duration:v1",
  "type": "string",
  "format": "duration"
}
```

### duration-ms — storage integer

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:duration-ms:v1",
  "type": "integer",
  "minimum": 0
}
```

### duration-seconds — storage integer

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:duration-seconds:v1",
  "type": "integer",
  "minimum": 0
}
```

### email — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:email:v1",
  "type": "string",
  "format": "email"
}
```

### field-set-fields — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:field-set-fields:v1",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "labels": {
        "$ref": "urn:madarch:value-type:localized-text:v1"
      },
      "name": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "nullable": {
        "$ref": "urn:madarch:value-type:boolean:v1"
      },
      "type": {
        "$ref": "urn:madarch:value-type:text:v1"
      }
    },
    "required": [
      "name",
      "type"
    ],
    "unevaluatedProperties": false
  }
}
```

### integer — storage integer

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:integer:v1",
  "type": "integer"
}
```

### ipv4 — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:ipv4:v1",
  "type": "string",
  "format": "ipv4"
}
```

### ipv6 — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:ipv6:v1",
  "type": "string",
  "format": "ipv6"
}
```

### json — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:json:v1",
  "anyOf": [
    {
      "type": "array"
    },
    {
      "type": "boolean"
    },
    {
      "type": "null"
    },
    {
      "type": "number"
    },
    {
      "type": "object"
    },
    {
      "type": "string"
    }
  ]
}
```

### key-activity — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-activity:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "activity"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-business-process — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-business-process:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "business-process"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.broker — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.broker:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.broker"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.channel — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.channel:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "address": {
          "$ref": "urn:madarch:value-type:text:v1"
        },
        "protocol": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "address",
        "protocol"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.channel"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.commit — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.commit:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "hash": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "hash"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.commit"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.contract — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.contract:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "repository": {
          "$ref": "urn:madarch:value-type:key-code.repository:v1"
        }
      },
      "required": [
        "path",
        "repository"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.contract"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.directory — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.directory:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "repository": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "path",
        "repository"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.directory"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.file — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.file:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "path": {
          "$ref": "urn:madarch:value-type:path:v1"
        },
        "repository": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "path",
        "repository"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.file"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.module — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.module:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.module"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.operation — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.operation:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "contract": {
          "$ref": "urn:madarch:value-type:key-code.contract:v1"
        },
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "contract",
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.operation"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.repository — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.repository:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.repository"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.service — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.service:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.service"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.symbol — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.symbol:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "file": {
          "$ref": "urn:madarch:value-type:key-code.file:v1"
        },
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "file",
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.symbol"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-code.test-case — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-code.test-case:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "file": {
          "$ref": "urn:madarch:value-type:key-code.file:v1"
        },
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "file",
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "code.test-case"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-doc.use-case — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-doc.use-case:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "identifier": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "identifier"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "doc.use-case"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-domain — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-domain:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "domain"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-domain-entity — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-domain-entity:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "domain-entity"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-event — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-event:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "event"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-person — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-person:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "person"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-product — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-product:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "product"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-role — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-role:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "role"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-runtime-scenario — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-runtime-scenario:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "runtime-scenario"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-state — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-state:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "machine": {
          "$ref": "urn:madarch:value-type:key-state-machine:v1"
        },
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "machine",
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "state"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-state-machine — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-state-machine:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "state-machine"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-test-result — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-test-result:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "at": {
          "$ref": "urn:madarch:value-type:timestamp:v1"
        },
        "test": {
          "$ref": "urn:madarch:value-type:key-code.test-case:v1"
        }
      },
      "required": [
        "at",
        "test"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "test-result"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-use-case-step — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-use-case-step:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "order": {
          "$ref": "urn:madarch:value-type:integer:v1"
        },
        "use_case": {
          "$ref": "urn:madarch:value-type:key-doc.use-case:v1"
        }
      },
      "required": [
        "order",
        "use_case"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "use-case-step"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-value-set — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-value-set:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "name"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "value-set"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### key-value-set-entry — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:key-value-set-entry:v1",
  "type": "object",
  "properties": {
    "key": {
      "type": "object",
      "properties": {
        "set": {
          "$ref": "urn:madarch:value-type:key-value-set:v1"
        },
        "value": {
          "$ref": "urn:madarch:value-type:text:v1"
        }
      },
      "required": [
        "set",
        "value"
      ],
      "unevaluatedProperties": false
    },
    "kind": {
      "type": "string",
      "const": "value-set-entry"
    }
  },
  "required": [
    "key",
    "kind"
  ],
  "unevaluatedProperties": false
}
```

### link-type-labels — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:link-type-labels:v1",
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "properties": {
      "in": {
        "$ref": "urn:madarch:value-type:text:v1"
      },
      "out": {
        "$ref": "urn:madarch:value-type:text:v1"
      }
    },
    "required": [
      "in",
      "out"
    ],
    "unevaluatedProperties": false
  }
}
```

### localized-text — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:localized-text:v1",
  "type": "object",
  "properties": {
    "en": {
      "$ref": "urn:madarch:value-type:text:v1"
    },
    "ru": {
      "$ref": "urn:madarch:value-type:text:v1"
    }
  },
  "required": [
    "en",
    "ru"
  ],
  "unevaluatedProperties": false
}
```

### money — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:money:v1",
  "type": "string",
  "pattern": "^[A-Z]{3} -?(0|[1-9][0-9]*)(\\.[0-9]+)?$"
}
```

### number — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:number:v1",
  "type": "number"
}
```

### path — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:path:v1",
  "type": "string",
  "minLength": 1,
  "pattern": "^[^\\u0000\\r\\n]+$"
}
```

### path-list — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:path-list:v1",
  "type": "array",
  "items": {
    "$ref": "urn:madarch:value-type:path:v1"
  }
}
```

### port — storage integer

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:port:v1",
  "type": "integer",
  "minimum": 1,
  "maximum": 65535
}
```

### port-list — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:port-list:v1",
  "type": "array",
  "items": {
    "$ref": "urn:madarch:value-type:port:v1"
  }
}
```

### text — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:text:v1",
  "type": "string"
}
```

### text-list — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:text-list:v1",
  "type": "array",
  "items": {
    "$ref": "urn:madarch:value-type:text:v1"
  }
}
```

### text-map — storage json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:text-map:v1",
  "type": "object",
  "additionalProperties": {
    "$ref": "urn:madarch:value-type:text:v1"
  }
}
```

### timestamp — storage timestamp

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:timestamp:v1",
  "type": "string",
  "format": "date-time"
}
```

### url — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:url:v1",
  "type": "string",
  "format": "uri"
}
```

### value-set-value — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:value-set-value:v1",
  "type": "string",
  "minLength": 1
}
```

### version — storage text

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:version:v1",
  "type": "string",
  "minLength": 1,
  "pattern": "^[^\\s\\u0000]+$"
}
```

## Reference-schema correction validation

The current writer stores references as `{kind, key}`, including references nested in natural keys. All 28 shared key schemas now declare that exact wrapped shape. `su box -c 'cd /tmp/madarch-64o5.138 && bun test test/starter-value-sets.test.ts'`: 1 pass, 0 fail, 7 assertions, exit 0 (14.15 seconds). No check remains running.

## Bigint representation correction

The bigint type accepts a JSON integer number or a canonical decimal string. Strings reject leading zeroes, plus signs and negative zero. Numeric range and safe-number checks remain writer responsibilities. Counts remain 596 kind fields, 10 edge fields, 127 JSON field schemas and 63 shared types.

## Fixed scalar enum membership

`class-diagram.level` now names the shared `class-diagram-level` text type, whose JSON Schema enum is `["code", "domain"]`, as its existing agent binding declares. Counts: 596 kind fields + 10 edge fields; 127 JSON schemas; 63 shared types. Kind text fields drop from 348 to 347; one field uses class-diagram-level.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:madarch:value-type:class-diagram-level:v1",
  "type": "string",
  "enum": [
    "code",
    "domain"
  ]
}
```

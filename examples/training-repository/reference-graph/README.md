# The reference graph of the training repository

What the generated repository really says, read from its files with real
parsers and from Git, without the fill's output. A score compares a filled
graph with this reference (`scripts/score-reference-graph.ts`), so the
reference must stand on its own: every entry cites the lines it rests on.

## Layout

- One YAML file per tracked file of the generated repository, mirroring its
  path: `services/orders/go.mod` → `services/orders/go.mod.yaml`. A file with
  nothing to state still has its file, and says why in its `label`.
- `repository.yaml` holds what no single file states: the repository, its
  services and their parts, the databases, the topics, the environment
  variables, and the commits, authors and tracker tasks read from `git log`.
- `GAPS.md` lists the facts the repository states that no kind of the
  vocabulary holds, and the readings that were left out.

## An entry

A node:

```yaml
- id: code.symbol:services/orders/internal/pricing/pricing.go#Discount
  kind: code.symbol
  label: Discount
  evidence:
    - path: services/orders/internal/pricing/pricing.go
      startLine: 12
      endLine: 12
      quote: 'func Discount(amountCents int64, percent int) int64 {'
  reading: parsed
```

An edge:

```yaml
- relation: code.calls
  from: code.symbol:services/orders/internal/pricing/pricing.go#Discount
  to: code.symbol:services/orders/internal/pricing/pricing.go#percentOf
  evidence:
    - path: services/orders/internal/pricing/pricing.go
      startLine: 19
      endLine: 19
      quote: '	return percentOf(amountCents, percent)'
  reading: parsed
```

`evidence` is a list of `{ path, startLine, endLine, quote }`; `quote` is the
exact text of those lines, without the final newline. An evidence item names
one line (`startLine` equals `endLine`) and a fact that needs several lines
carries several items, so a quote is always one line of a file. A fact read
from Git carries `{ command, quote }` instead: `command` is the exact git
command, run in the repository, and `quote` is one line of its output.

`reading` is:

- `parsed` — a real parser states it: the Go syntax tree (`go/parser`), the
  TypeScript syntax tree (`@swc/core`), a YAML document, a SQL script read
  table by table, Git;
- `declared` — a manifest or a configuration states it in a field: `go.mod`,
  `package.json`, a compose file, a Kubernetes object, a CI workflow, a
  Makefile target;
- `judgement` — a reader has to decide what it means: that a page is a runbook,
  that a document is stale, that a plan describes a service nobody built.

## Ids

An id is the kind and the name a reader would use, and nothing else: no
digests, no database row ids. The same name always gives the same id, across
files, because an id names one thing in the repository.

| kind | id | example |
| --- | --- | --- |
| `code.file` | `code.file:<path>` | `code.file:services/orders/go.mod` |
| `code.module` | `code.module:<directory>` | `code.module:services/orders/internal/api` |
| `code.symbol` | `code.symbol:<path>#<name>`, a method as `#<Type>.<name>` | `code.symbol:services/orders/internal/domain/order.go#Order.Apply` |
| `code.field` | `code.field:<path>#<Type>.<name>` | `code.field:services/orders/internal/domain/order.go#Order.Status` |
| `code.route` | `code.route:<service>:<METHOD> <path>` | `code.route:orders:GET /orders/{id}` |
| `code.operation` | `code.operation:<contract>#<operationId or RPC>` | `code.operation:contracts/openapi/orders.yaml#createOrder` |
| `code.channel` | `code.channel:<topic>` | `code.channel:orders.events` |
| `code.message` | `code.message:<name>` | `code.message:OrderChanged` |
| `code.table` | `code.table:<database>.<table>` | `code.table:orders.orders` |
| `code.column` | `code.column:<database>.<table>.<column>` | `code.column:orders.orders.status` |
| `code.index` | `code.index:<database>.<name>` | `code.index:orders.orders_request_idx` |
| `code.database` | `code.database:<name>` | `code.database:orders` |
| `code.env-var` | `code.env-var:<NAME>` | `code.env-var:DATABASE_URL` |
| `code.env-definition` | `code.env-definition:<path>#<NAME>` | `code.env-definition:.env.example#JWT_SECRET` |
| `code.dependency` | `code.dependency:<manifest>#<name>` | `code.dependency:services/orders/go.mod#github.com/lib/pq` |
| `code.make-target` | `code.make-target:<name>` | `code.make-target:test` |
| `code.ci-workflow` | `code.ci-workflow:<path>` | `code.ci-workflow:.github/workflows/ci.yml` |
| `code.ci-job` | `code.ci-job:<workflow>#<job>` | `code.ci-job:ci#orders` |
| `code.document` | `code.document:<path>` | `code.document:docs/requirements.md` |
| `code.document-section` | `code.document-section:<path>#<heading>` | `code.document-section:docs/requirements.md#Business rules` |
| `code.state-machine` | `code.state-machine:<aggregate>.<field>` | `code.state-machine:Order.status` |
| `code.state` | `code.state:<name>` | `code.state:pending_payment` |
| `code.test-case` | `code.test-case:<path>#<name>` | `code.test-case:services/orders/internal/pricing/pricing_test.go#TestTax` |
| `code.commit` | `code.commit:<sha>` | `code.commit:0657ebc...` |
| `code.author` | `code.author:<email>` | `code.author:avery@example.com` |
| `code.task` | `code.task:<key>` | `code.task:ORD-113` |

The remaining kinds (`code.service`, `code.package`, `code.dockerfile`,
`code.image`, `code.compose-service`, `code.k8s-deployment`, `code.k8s-service`,
`code.port`, `code.probe`, `code.health-endpoint`, `code.metrics-endpoint`,
`code.metric`, `code.contract`, `code.migration`, `code.lockfile`,
`code.manifest`, `code.broker`, `code.logger`, `code.debt`, `code.cycle`,
`code.entry-point`, `code.input`, `code.sql-build`, `code.sql-sink`,
`code.snapshot`, `code.repository`) take the natural name of the thing after
the colon: `code.service:orders`, `code.metric:orders_created_total`,
`code.probe:orders.readiness`, `code.debt:services/payments/src/config.ts:1`.

## Relations

Only relations of `src/knowledge/starter-mapping.ts` are used, in the
producer's spelling (`code.contains`, `code.calls`, `code.imports`,
`code.publishes`, …). Two relations are chosen by the catalog's own model, not
by taste: a file holds a symbol (`code.contains`, the file's declared `out`
relation), a symbol belongs to its file (`code.belongs-to` would be the
inverse and is not written twice), a document holds a section
(`code.contains`), a commit touched a file (`code.touched`), a commit is
authored by an author (`code.authored`), a commit follows its parent
(`code.parent`).

## Optional fields the scorer honours

Three things a reference may state, none of them required:

- `scored: false` on a node or an edge takes it, and every edge that touches
  it, out of every count; the scorer reports their number as a total.
- `scope` on an edge: `direct` (or no `scope`) is scored; any other value keeps
  the edge out of the direct-call counts and is reported apart, under its
  scope's name.
- `SCORING.md` at this folder's root lists every kind and relation, one row
  each, with `recall` (does the reference ask to be recalled there?) and
  `scored` (is the name compared at all?), and a `why` where the answer is no:

  ```markdown
  | name | recall | scored | why |
  | --- | --- | --- | --- |
  | `code.symbol` | yes | yes | |
  | `code.references` | no | no | the reference states calls, not name resolutions |
  ```

  `recall: no` prints `n/a` for that name's recall. `scored: no` keeps both
  sides of the name out of every count: the reference's entries and the graph's
  records of it, and the edges that touch it, are reported apart instead. A name
  the file does not mention is scored and recalled as usual.

## What is deliberately not here

`GAPS.md` names it: standard-library imports (no kind holds a language's
standard library), expressions, raw name mentions, transitive lock-file rows,
and the calls whose target cannot be established from the file that calls.

# Intended model: format reference for writers

This is the format a writer of a madarch intended model needs: the field
names of every construct, one short YAML example per construct, and the
review report's tables exactly as the model check parses them. The full
specification is `docs/system/capabilities/intended-model.md` in the madarch
checkout; the published schema is `schema/intended-model.schema.json` there.

A model is every `*.yaml` file in the repository's `madarch/` folder, read as
one. Each file starts with `version: 1`. The loader is strict: anchors,
aliases, merge keys, custom tags and duplicate keys are refused; so is any
field the schema does not define. Ids are unique within their kind, of
letters, digits, dots, dashes and underscores, starting with a letter or a
digit.

## Element

An element is a part of the system: a person or role, an external system, a
domain, a system, a service, a module, a store, a broker. Fields:

- `id` (required) — stable; never encode a path or a kind in it, so it
  survives moves and renames.
- `kind` (required) — one of `person`, `external`, `domain`, `system`,
  `service`, `module`, `store`, `broker`.
- `name` — a readable name of two to four words, a reader's label ("Model
  endpoint", "OS keystore"); the detail goes into the review report, not
  the name.
- `parent` — the id of the element this one is part of; elements nest to any
  depth.
- `technology` — what it is built with ("TypeScript, NestJS").
- `evidence` — the list of items naming the text the element was written
  from; see Evidence.
- `zones` — which zones the element belongs to, as `add`, `exclude` or
  `replace` lists; see Zones and categories.
- `environments` — when set, the element exists only in the named
  environments (see the spec for environments).
- `since`, `until` — architecture states the element exists from and to (see
  the spec for states).

```yaml
elements:
  - id: orders-api
    kind: service
    name: Orders API
    parent: ordering
    technology: Java, Spring Boot
    zones:
      add: [pci]
    evidence:
      - file: services/orders/src/main.ts
        line: 1
        commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
        blob: ae41b0c9127f3d55c1f4d68f2a99c53f2b18e7d0
```

## Interface

An interface is one capability an element offers to others: an API, a topic,
a table, a gRPC service. Fields:

- `id` (required) — stable, like every id.
- `provider` (required) — the id of the element that offers the capability.
- `contract` (required) — the contract id, `kind::rest`, the kind one of
  `http`, `grpc`, `topic`, `queue`, `data`, `rpc`. The compiler normalizes
  what is written — HTTP methods to upper case, path parameters to `{}` —
  so `http::GET::/api/orders/{orderId}` compiles to
  `http::GET::/api/orders/{}`; both spellings are the same contract id.
- `evidence` — its contract file and where its provider registers it.

```yaml
interfaces:
  - id: orders-place
    provider: orders-api
    contract: grpc::ordering.v1.Orders/PlaceOrder
    evidence:
      - file: api/orders.proto
        line: 14
        endLine: 18
        commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
        blob: 5ad3e9c2bb71f04a3e6d12c8f79b0a44e2d51c93
  - id: topic-order-placed
    provider: event-bus
    contract: topic::order-placed
  - id: orders-read
    provider: orders-api
    contract: http::GET::/api/orders/{orderId}
```

## Relation

A relation is a dependency of one element on another, written from the
initiator to what it depends on. Fields:

- `id` (required) — stable, like every id.
- `from` (required), `to` (required) — the initiator and what it depends on.
- `name` — what the relation does, in a few words ("places orders"); a
  relation without one is warned about.
- `refines` — the id of a relation this one is a refinement of; the
  refinement's ends must be the refined relation's ends or their
  descendants.
- `interface` — the id of the interface the interaction goes through; a
  relation that names an interface or carries transfers is an interaction
  with its own id.
- `action` — `send` or `receive`, only on a relation through an interface
  whose contract kind is `topic` or `queue`: how the initiator uses it. The
  ends stay initiator → what it depends on (usually the broker).
- `binding` — which environment variable the interaction reaches its
  interface through (`env`); values live in environments, never secrets.
- `transfers` — the data transfers, each with its `direction` (`forward`,
  from the initiator, or `reverse`), its `confidentiality` (a word such as
  `public`, `internal`, `confidential`) and its `categories` (data category
  ids). Write them where the code shows the data crossing.
- `evidence` — where the dependency is found: the import line for a
  dependency in imports; for an interaction at run time, the handler
  registration or the call or send site, never an import alone.
- `since`, `until` — architecture states, as on an element.

```yaml
relations:
  - id: checkout-places-order
    name: places the order
    from: checkout
    to: orders-api
    interface: orders-place
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: [personal, order]
    evidence:
      - file: services/checkout/src/orders.ts
        line: 42
        commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
        blob: c27b91ea6f04d5338f12a9c07b4e88d1a6f35b29
  - id: payment-step-authorizes
    name: authorizes the payment
    refines: checkout-pays
    from: checkout-payment
    to: payments-api
  - id: orders-publishes-placed
    name: publishes order-placed
    from: orders-api
    to: event-bus
    interface: topic-order-placed
    action: send
  - id: invoices-awaits-confirmed
    name: receives order-confirmed
    from: invoices-api
    to: event-bus
    interface: topic-order-confirmed
    action: receive
```

## Evidence

An evidence item names the text a thing was written from. It is a list item
under `evidence` on an element, an interface or a relation. Fields:

- `file` (required) — the file's path from the repository root, with forward
  slashes.
- `line` — the first line of the text that supports the thing (1-based).
- `endLine` — the last line of a range; needs `line` and may not come before
  it.
- `commit` — the commit the file was read at: 40 hexadecimal digits, lower
  case. Given together with `blob` or with neither. Every item of one run
  pins the same commit: the repository's HEAD when the survey started.
- `blob` — the file's git blob id at that commit: 40 hexadecimal digits,
  lower case, so the item still identifies the exact text after a squash or
  a rebase removes the commit. Compute it, never type it by hand:
  `git -C "$REPO" rev-parse "<commit>:<file>"`.

What the evidence must name, by the kind of thing:

- an element: its entry point, where it is wired together, or its public
  contract;
- an external element: the text that names or reaches it — the client's
  construction, the configured address or variable, the call site (an
  external system has no code in the repository);
- a dependency found in imports: the import line;
- an interaction at run time: where the handler is registered, or the call
  or send site — never an import alone;
- an interface: its contract file and where its provider registers it;
  where the repository has no contract file (no OpenAPI, protobuf or
  schema), where the provider registers it and the handler that serves it;
- a group of modules: where its members are wired, not a list of folders.

Commit the code being described before pinning: evidence names committed
text, and the model check resolves every item in git. In a real run the
commit and blob are computed; placeholders are used only in this skill's
worked example, whose test substitutes them.

```yaml
evidence:
  - file: src/checkout/cart.ts
    line: 12
    endLine: 30
    commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
    blob: 9f2d61c07b3a5188e4c02fa7d9b1136ca58e4f7b
  - file: src/checkout/index.ts
    line: 3
    commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
    blob: 04b7e19c2fa63d8510cbb6f2794a52ee8d13c6a0
```

## Zones and categories

A zone is a boundary elements belong to other than their parent: a network
segment, a trust boundary, a regulatory scope. A zone has an `id`, a
free-word `kind` (`network`, `trust`, `regulatory`) and a `name`. An element
is in its parent's zones unless it adds, excludes or replaces them; a data
transfer names categories, each a `categories` entry with an `id` and a
`name`.

```yaml
zones:
  - id: internal
    kind: network
    name: Internal network
  - id: pci
    kind: regulatory
    name: PCI DSS cardholder data environment

categories:
  - id: personal
    name: Personal data
```

Environments (deployment-specific bindings and zones) and architecture
states (`since`/`until` chains) exist in the format; see the spec in the
madarch checkout before using them — a first model rarely needs either.

## The review report `madarch/review.md`

The report stands beside the model. The model check reads its two tables by
their level-2 headings and parses them strictly: the header row and the
separator row must be exactly as below, every data row must have the header's
number of cells, a cell containing a literal `|` writes it escaped as `\|`,
and a table ends at the first line that is not a row. The other two sections
(`Undocumented`, `Problems`) are free-form prose the check does not parse.

Open the report with one line naming the commit the model describes — the
repository's HEAD at the start of the run.

### `## Claims`

```markdown
## Claims

| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The clerk scans receipts into `inbox/` | README.md | 3-5 | 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21 | ae41b0c9127f3d55c1f4d68f2a99c53f2b18e7d0 | src/index.ts:10-12 | confirmed | importer |
| The Cleaner removes duplicates | docs/architecture.md | 9 | 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21 | 5ad3e9c2bb71f04a3e6d12c8f79b0a44e2d51c93 | src/ (no Cleaner exists) | contradicted | importer |
| Phase 2 mirrors the archive to S3 | docs/architecture.md | 17 | 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21 | 5ad3e9c2bb71f04a3e6d12c8f79b0a44e2d51c93 | announced plan; nothing in the code | planned | — |
```

Columns, in order:

- `Claim` — the claim in one sentence.
- `Document` — the file's path from the repository root; backticks are
  stripped if present.
- `Line` — the line, a `from-to` range, or empty.
- `Commit` and `Blob` — of the **document file** the claim was read from;
  full ids of 40 hexadecimal digits, computed the same way as evidence
  (`git -C "$REPO" rev-parse "<commit>:<file>"`) — a shortened id is
  refused by the check.
- `Checked in code` — the code the claim was checked against, as
  `file:lines`, or what you found in its place ("no Cleaner exists").
- `Verdict` — exactly one of `confirmed`, `contradicted`, `stale`,
  `planned`, `unconfirmed`.
- `In the model` — the element id the claim became, or `—` when the model
  holds nothing for it.

### `## Undocumented`

A list, free-form: each part the code shows and no document claims, the code
that shows it, and the element or elements it became.

### `## Assignment`

```markdown
## Assignment

| Path | Element | Reason |
| --- | --- | --- |
| `madarch/` | excluded | the model and its review |
| `docs/` | receipts | the architecture document; read for claims |
| `src/index.ts` | importer | the entry point |
| `src/notify/` | webhook | no document mentions it; found in the code |
```

Columns, in order:

- `Path` — a file, or a folder with the path ending in `/` (the row covers
  everything under it). Backticks are stripped if present.
- `Element` — the id of an element of the model, or the word `excluded`.
- `Reason` — why the path belongs there; an `excluded` row must have one.

Every file tracked by git at the checked revision must be covered by a row;
where rows overlap, the deepest row decides. Assign contract and schema
files to the element that offers the interface, or exclude them with a
reason.

### `## Problems`

Free-form. Every problem the model check reported — each with the method
that defines it, its source, and the ids of the elements and relations
involved, as the check printed them — and then the questions only a reader
can raise (a risk, a threat), written as questions with their source, never
as defects.

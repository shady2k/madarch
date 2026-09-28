---
name: write-intended-model
description: Write or check a repository's intended model for madarch — the YAML architecture model in the repository's madarch/ folder, with its review report and evidence. Use when asked to write, check, review or update a madarch intended model for a repository.
---

# Write the intended model of a repository

You will write the **intended model** of a repository: what its architecture
is declared to be — elements, interfaces, relations, zones, data categories —
as YAML in the repository's `madarch/` folder, with a review report
`madarch/review.md` beside it, every fact backed by **evidence** naming the
exact text it was read from, at a commit and a blob.

Work for a reader who was not in this conversation: every claim in the report
names where it came from, so a person can check it without asking you.

## Before you start

- `$REPO` is the repository to model; `$MADARCH` is a checkout of madarch.
  Both must exist; `$REPO` must be a git checkout. All commands below take
  paths as arguments, so run them from anywhere.
- `git -C "$REPO" status --porcelain` must print nothing for the files you
  will describe. Evidence names committed text and the check resolves it in
  git, not in the working tree — if the code is uncommitted, the pin misses
  what you read. If it is not clean, stop and ask for the code to be
  committed first.
- Confirm claims by reading: the code, its tests and its configuration — do
  not run the repository's code, start its services or probe it with stubs.
  Evidence is text at a commit, and running someone's code has effects
  nobody asked for. A defect you suspect from reading goes into Problems as
  a question, with the lines that raise it.
- Read `reference.md` (beside this file) before writing anything. It holds
  the field names of every construct with one YAML example each, and the
  exact shape of the review report's tables, which the model check parses
  strictly.
- Words to use (the glossary): **intended model** (the YAML in `madarch/`),
  **element** (a part with a stable id), **interface** (a capability a part
  offers, identified by its **contract id**), **relation** (a dependency of
  one element on another, declared by its initiator), **interaction** (a
  relation that names an interface or carries data transfers), **action**
  (`send` or `receive`, only through a topic or queue), **data transfer**
  (data moving in one direction of an interaction), **zone** (a boundary an
  element belongs to other than its parent), **evidence** (the files and
  lines a thing was written from).

## Procedure

### 1. Survey the repository

Run, and keep the outputs:

```sh
git -C "$REPO" rev-parse HEAD
git -C "$REPO" ls-tree -r --name-only HEAD
```

The commit from the first command is **the commit every evidence item pins**.
The second lists every tracked file.

Then survey the tree, and keep a note of what you found and where:

- **Documents**: `README*`, anything under `docs/` (architecture documents,
  decision records, specifications), contract and schema files (OpenAPI,
  protobuf, GraphQL).
- **Entry points and build manifests**: `package.json`, `go.mod`,
  `Cargo.toml`, `pom.xml`, `build.gradle`, `Dockerfile`, `docker-compose`,
  Makefiles, and the files they name as entries.
- Anything that looks like a deployment boundary: separate processes,
  binaries, daemons, remote helpers, data folders, configuration for
  external services.

### 2. Read the documents first; write the claims ledger

Claims come from the documents that describe the architecture: the README,
architecture documents, accepted decision records, specifications, contract
descriptions. Research notes, working plans and release notes are read for
parts the code confirms, but not transcribed. Why: the report is read by a
person deciding which documents are out of date, and a table that
transcribes every sentence buries the decisions — a large repository's
claims table is tens to a few hundred rows.

Read each of these documents top to bottom. For every **architectural
claim** it makes — a part, what it holds or does, what it talks to, its
technology, a plan — write one row of a working ledger (a scratch file or
notes, not yet the report), not one row per sentence:

- the claim, in one sentence;
- the document's path and the line or lines it is written on;
- what kind of source it is:
  - an **accepted decision record or a specification** states *intent* —
    it enters the model even where the code disagrees, and the disagreement
    is reported;
  - **descriptive prose** is a *hypothesis* — it enters the model only
    where the code confirms it;
  - an **announced plan** ("in phase 2", "we will move to") is *planned* —
    it is reported, never modelled.

A claim is architectural when it says a part exists, that a part holds or
does something, that A talks to B, what technology a part uses, or what is
planned. Style, licensing, contribution rules and build instructions are not
claims. Why: the model describes architecture, and a ledger of claims is what
makes the comparison with the code checkable by a reader later.

### 3. Confirm each claim in the code

Look for each claim in the code: entry points, wiring, imports, call sites,
registrations, schemas. Give every claim one verdict:

- `confirmed` — the code shows it;
- `contradicted` — the code shows the opposite: a part the document names is
  gone or was replaced by another, or behaves differently than written;
- `stale` — the claim was true of an earlier state and the code has outgrown
  it as stated (counts, versions, sizes that no longer hold, nothing opposite
  in their place);
- `planned` — an announced plan (you searched, and the code does not have it
  yet);
- `unconfirmed` — you searched the code and found nothing either way.

Judge a claim that makes several statements per statement: a count that
still holds beside a part the code replaced is `confirmed`, and the
statement naming the replaced part is `contradicted`; a count that no
longer holds with nothing in its place is `stale`. Why: one verdict for
the whole claim would say the code agrees with all of it or with none.

What enters the model:

- intent enters even where the code disagrees, and the disagreement goes to
  the report — why: the documents are what the owners decided;
- a hypothesis enters only where the code confirms it — why: prose is not a
  decision;
- a plan never enters the model — why: the model describes what is, not what
  is announced;
- the code the documents have outgrown is what the model describes, and the
  claim is reported with the code it was checked against.

### 4. Write down what the code shows that no document says

While you survey, note every architecturally significant part the documents
never claim: processes and binaries, stores, packages the core imports,
helpers on remote hosts, external systems the code calls. Each one enters the
model and is reported as **undocumented**. Do not model every file — a
repository's classes, utilities and tests are not architecture. Why: the
reader needs the parts that change the shape of the system, not an inventory.

### 5. Shape the model: three levels, kinds, ids

The model has three levels:

1. **Context**: the people, the external systems, and the system itself (one
   `system` element for the repository).
2. **The system's parts**: its applications, processes, services, stores,
   brokers, helpers on remote hosts — children of the system.
3. **The modules of its core**, **grouped by concern**: for a large core,
   8–10 groups. A group is a `module` element whose children are modules, or
   which stands for several packages. Do not model every package — the
   assignment table accounts for each file, the model does not have to.
   For a small core, model its modules directly.

At the third level, relations **between the groups** are the point of the
page: for each pair of groups where code of one imports code of the other,
write one relation from the importer to the imported group, named for what
it uses, with one import line as its evidence (more lines optional). Derive
the pairs from the language's import graph, not by guessing — for Go,
`go list -f '{{.ImportPath}} {{join .Imports " "}}' ./...` mapped onto the
groups by the assignment table; for TypeScript, the import statements. Why:
a page of groups with no arrows between them says nothing, and the pairs
the import graph shows are exactly the ones evidence can support.

Element kinds: `person`, `external`, `domain`, `system`, `service`, `module`,
`store`, `broker`. Pick the kind from what the part is, not from where it
sits in a folder tree.

`store` is for where the system keeps its data of record, whatever holds it
— a database, a file folder, or an in-memory register playing that role; a
cache, or a helper holding data briefly, is a `module`. Why: the reader
looks for where the data lives.

Ids are stable: letters, digits, dots, dashes, underscores, starting with a
letter or a digit (`orders-api`, `checkout.cart`). Never encode a path or a
kind in an id — ids must survive moves and renames unchanged.

### 6. Interfaces by capability

One interface per **capability** a part offers — an API, a topic, a table,
a gRPC service. Size them by capability, not by method or namespace: a large
RPC surface becomes about 10–15 interfaces, not one per route. Why: the model
is read at capability grain; a reader asks "what does this offer", not "which
methods".

Contract ids have the form `kind::rest`, the kind one of `http`, `grpc`,
`topic`, `queue`, `data`, `rpc`. The compiler normalizes what you write —
HTTP methods to upper case, path parameters to `{}` — so
`http::GET::/api/orders/{orderId}` and `http::GET::/api/orders/{}` are the
same contract id; keep the parameter's name, as the reference system does.
See `reference.md` for one example of each kind.

Every contract file (an OpenAPI document, a `.proto`, a schema) is assigned
to an element or excluded in the assignment table, like every other tracked
file.

### 7. Relations

Every relation is written from the **initiator** to what it depends on, and
has a `name` saying what it does in a few words ("places orders"). A
relation through a topic or queue carries `action: send` (the initiator
publishes or sends) or `action: receive` (it subscribes or receives); the
ends stay initiator → what it depends on, usually the broker. A relation
whose ends are known in more detail than another's may `refine` it. Where
the code shows the data crossing, give the interaction **data transfers**
with a direction, a confidentiality and categories.

A relation to a store, an external system or another part starts at the
**group whose code makes the call**, not at the service that contains it.
Why: the views collapse the relation back to the service at the level
above, so nothing is lost there, and the group's page keeps the arrow its
own code earns.

Before finishing, open the core's page: a level whose boxes have no arrows
between them is not finished. A hidden-coupling problem between two groups
is a prompt to look for a relation the model lacks — add it with evidence
if the code shows one, otherwise report it.

Model the dependencies you found evidence for, no more. Why: a relation
without evidence cannot be checked, and one the code does not show is
invented.

### 8. Write the evidence

Every element, every interface and every relation carries at least one
evidence item, and the model check refuses the model without one. What
evidence names, by the kind of thing (these rules are exact):

| The thing | Its evidence names |
| --- | --- |
| an element | its entry point, where it is wired together, or its public contract |
| an external element | the text that names or reaches it — the client's construction, the configured address or variable, the call site (an external system has no code in the repository) |
| a dependency found in imports | the import line |
| an interaction at run time | where the handler is registered, or where the call or send is made — never an import alone |
| an interface | its contract file and where its provider registers it; where the repository has no contract file (no OpenAPI, protobuf or schema), where the provider registers it and the handler that serves it |
| a group of modules | where its members are wired, not a list of folders |

Each evidence item names `file` (path from the repository root), `line`, and
`endLine` for a range; plus `commit` — the HEAD from step 1 — and `blob`:

```sh
git -C "$REPO" rev-parse "<commit>:<path/to/file>"
```

Never type a blob by hand: it is 40 hexadecimal digits, and one wrong
character makes the check fail — or worse, pins the wrong text. Compute it.
The code being described must be committed before you pin: evidence names
committed text.

### 9. Write the review report `madarch/review.md`

The report stands beside the model and is what a reader checks you against.
It holds, in this order (the exact table shapes are in `reference.md` — the
check parses them strictly):

- an opening line naming the commit the model describes (the HEAD from
  step 1);
- `## Claims` — one row per document claim from your ledger: the claim, its
  document, its line or range, the commit and blob **of the document file**,
  the code you checked it against (`file:lines`), the verdict (one of the
  five words), and what the model does with it (an element id, or `—` when
  nothing);
- `## Undocumented` — the findings from step 4, each with the code that shows
  it and the element or elements it became;
- `## Assignment` — one row per path: a file, or a folder (path ending in
  `/`, covering everything under it), and the element it belongs to or
  `excluded` with a reason. Every tracked file must be covered; the deepest
  row covering a file decides it. Give the model's own folder the row
  `madarch/ | excluded | the model and its review`. Documents go to the
  element they describe (usually the system) with the reason "read for
  claims".
- `## Problems` — every problem, each with the method that defines it, its
  source, and the ids of the elements and relations involved; then the
  questions only a reader can raise — a risk, a threat — written as
  questions, with their source, never as defects.

Why a report beside the model and not marks inside it: an element holds
several claims (that it exists, its parent, its kind) that the documents and
the code can confirm differently.

### 10. Run the check with views, and read what it rendered

```sh
bun "$MADARCH/scripts/check-model.ts" "$REPO" --views "$REPO/madarch/views"
```

Exit code 0 is a pass, 1 means something failed, 2 means the repository or
its model could not be read. `--json` prints the same report as one JSON
object if you need to read it programmatically.

Fix every error it reports and run it again — a line past the end of its
file, a missing commit or blob, a tracked file no assignment row covers —
until it exits 0. Stale items and problems do not fail the check; you
report them, you do not fix them silently.

When it passes, open every page in `$REPO/madarch/views/mermaid/` and read
each as a reader would:

- does the landscape hold about ten boxes or fewer?
- does each level say something, or is it a list?
- are the names readable at the size they are drawn?

Copy the check's problems into the report's Problems section, each with its
method and source and the ids it named (the check prints them). Add the
questions a reader of the pages raises — risks, threats — as questions with
their source.

### 11. Finish only on a passing check

Finish only after a run that exits 0 with the views read. Then tell the
person what the check still lists as **stale** (files changed since the
evidence was read) and as **problems**, and where the model and report are.
Leave the commit of the model and report to them — the report is what they
read to accept the work.

The check reads the model from the working folder; you do not need to commit
it to run the check.

## If a run fails

A failed run leaves the previous model and report as they were in git. Your
files are worktree changes, never commits: until the check passes, an old
`madarch/` is one `git -C "$REPO" restore madarch` away, and a repository
with no model yet must not keep a half-written one. So stop only in one of
two states — the check passes and the new model and report stand, or the
previous state is restored (`git -C "$REPO" restore madarch`, deleting the
files you added when there was no previous model). Write nothing outside
`madarch/`: the views go to `$REPO/madarch/views`.

## Updating the model for a pull request

Specified in model-authoring/update; written in a later task.

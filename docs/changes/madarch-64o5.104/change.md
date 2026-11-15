# «Создать задачу» opens a task entity as the person, and the problem links to it

Change: madarch-64o5.104
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-64o5.104
Kind: no-behavior

## Intent
The owner pressed «Создать задачу» on a «Большой файл» problem on a product's Problems page and read the refusal of a
retired path: «…/madarch/catalog.yaml:1: authored entities now live in the database. Open the kind in the catalogue and
use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.» The button still wrote a
`docs/tasks` file through a path that no longer exists, and `POST /api/task-create` answered the same refusal with no
caller of its own.

A press now writes one task entity of the product's own task kind — the starter catalogue's task, declared in
`catalog/work/execution/task.yaml` — through the one write path MCP and the agent use (`putEntity`, the graph writer),
with the person as the write's source, its producer `person` and its version the person's name and address, and the
press as its evidence. The journal keeps it.

The task's record names the problem's stable id as its rule and identity, the way the dismissal kind names a problem,
beside its file, its line and its statement. Its title and body are written in the language the product's pages are
written in («Исправить: Большой файл — src/big.ts:1»), and every code rule now states its finding in both languages, so
the statement reads «731 строка при пороге 600» instead of the engine's English sentence.

The Problems listing reads the product's tasks and links each problem to its task, so the row shows «Есть задача:» with
the task's page and the press opens that task; the route answers `state: existing` to a second press instead of writing a
second task. Every refusal of the press is said in the product's language and names no path of this machine.
`POST /api/task-create` and `KnowledgeProduct.createTask` are gone, with no caller left.

## Out of scope
The other retired task lifecycle routes (`/api/task-propose`, `/api/task-close`, `/api/task-run`); the file-based
«Не проблема» dismissal, which still writes a `docs/problems` file the graph-based listing does not read; a relation
edge from the task to the problem's entity, which would also put the problem's file on the task's page.

## Rationale
The owner's rule of 2026-11-13: a person never edits the graph directly; a person's change arrives as a request or a
task, through the one write path that MCP and the agent use, and every write names its source. A press that answers with
a path of the checker's machine is neither a request nor a task, and the person could not act on the problem at all.

Mutation is not run on this branch: it is filed for the stage's assembled mutation run, as the stage rule has it.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/app: the page still reads its listing through the retained command and the graph through /graphql; only what the press writes and what the row links to change.
- wiki/pages: an entity's page is still `/e/` with its kind and its id; the task's link is that address, and the page opens it.
- product-repository/manifest: the write still names the product's declared kind and its declared fields, with its evidence; the engine names no kind of its own.

## Coverage
- product-wiki/app: static, test, mutation, review
- wiki/pages: test, review
- product-repository/manifest: static, test, review

## Where it is seen
Kind: request
Place: POST /api/problem-task, pressed by «Создать задачу» on /p/problems of a product

1. Pressing «Создать задачу» on a «Большой файл» row answers one task, and the row then shows «Есть задача:» with a link to the task's page.
2. Pressing «Создать задачу» on that row again answers the same task and opens its page, and no second task is written.
3. Opening the task's page shows the task's title in the product's language; a refused press answers its reason in that language and names no path of the machine.

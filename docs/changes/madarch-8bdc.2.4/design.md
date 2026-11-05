# Porting the operations, contracts and data-model readings onto the code facts

Status: the three stages are **not** written. This note records what each of them
needs, measured on the generated training repository and read from the extractor
code, so that the work starts from evidence rather than from a second survey.

## What the driver publishes today (training repository, final tree)

| Reading | Nodes | Edges | Kinds |
| --- | --- | --- | --- |
| operations | 234 | 431 | 30 node kinds (service, manifest, dependency, lockfile, dockerfile, image, compose-service, k8s-deployment, k8s-service, port, probe, healthcheck, env-definition, env-var, make-target, ci-workflow, ci-job, newcomer-*, logger, metric, metrics-endpoint, health-endpoint, broker, channel, process, symbol, file …) and 24 edge types |
| contracts | 51 | 147 | contract, operation, route, entry-point, channel, message, input, sql-build, sql-sink |
| data model | 161 | 359 | database, migration, table, column, index, symbol, file; foreign-key, logical-reference, reads-table, writes-table, contains, creates, alters, holds, covers, uses-database |

## The rule that makes a per-file port exact

A record is owned by the file its `span` stands in — the file whose bytes the
record cites. A unit publishes exactly the records it owns, plus the edges whose
span it owns. The graph's identity of a node is its key and of an edge its two
ends, so a record owned by two files would be published twice; the table below
shows that on the training repository every record has one owner.

## Per reading: what each owned record needs beyond its own file

### Data model

| Record | Owner | Needs from elsewhere |
| --- | --- | --- |
| `code.database` | the file holding the first storage evidence (a `migrations` folder's first file, or `schema.prisma`) | the service unit the folder belongs to (`serviceUnits(tree)`, a scan of every `go.mod` and `package.json`) |
| `code.migration` | the migration file | the ordinal: every migration of the same database, in the driver's order (`migrations` sorted by database then name, Prisma migrations after plain SQL ones) |
| `code.table`, `code.column`, `code.index` | the statement that declares them | for a column a later migration adds: the table node the earlier migration created, by `tableKey`; for a merged table, the columns of the other migrations of the same table (the driver merges `MergedTable.columns`, and `code.contains` table→column edges carry the *column's* span, so the column's unit owns them) |
| `code.symbol` | the code file holding the function | the qualified name and the position (`symbolKey(path, qualifiedName, line, byte)`) — the syntax stage's `code.symbol` nodes hold both (`qualifiedName`, `provenance.place.range`) |
| `code.reads-table`, `code.writes-table` | the code file of the access | the table's database (by name, across services, with the logical-reference rule), and for Go the package's call roll-up (`indexGoPackage` + `resolveGoCalls` over every file of the package) |
| `code.foreign-key`, `code.logical-reference`, `code.alters`, `code.holds`, `code.creates`, `code.covers`, `code.uses-database` | the file whose span the driver gives the edge | the other end's node key, by the key helpers (`tableKey`, `columnKey`, `databaseKey`) |
| seed-script writes | the script file | the tables of every database (the driver refuses an ambiguous owner and names a gap) |

The per-file readers are already pure and reusable:
`extractFileAccess(path, bytes)` (a whole `FileAccess` from one file's bytes),
`parseSqlScript`, `parsePrismaSchema`, `declaresTables`, `scanScriptWrites`.

### Contracts

| Record | Owner | Needs from elsewhere |
| --- | --- | --- |
| `code.contract`, `code.operation`, `code.message`, `code.input` (of a contract) | the contract file | for an operation's `service`: the listener ports of every code file (`portsByService`, built from `readTsFile`/`readGoFile`), matched against the operation's `servers` |
| `code.channel` | the AsyncAPI file | `consumerFound`/`consumerStatus`, folded from the `code.consumes` edges a symbol of another file published (`edges.filter(type === code.consumes && to === channel)`), which come from the Go Kafka scan (`readGoFile(...).kafkaSites`, the topic constants of the service) |
| `code.route`, `code.entry-point` | the code file | the route's `ports` (same per-service port fact), its `handlerKey` (`contractSymbols.handler`, code facts), and for a Go entry point `resolveGoStarts` over the files of its package |
| `code.input` | the code file | `readTsFile(...).inputs` (per file) |
| `code.serves`, `code.calls-remote`, `code.handled-by`, `code.starts`, `code.belongs-to`, `code.references`, `code.consumes`, `code.publishes`, `code.flows-into`, `code.carries`, `code.declares` | the file whose span the driver gives the edge | the other end: an operation or route key by a *value* (method + path template), a service key by name, a channel key by topic |
| `code.sql-build`, `code.sql-sink` | the code file | the file's local binding chains (code facts) |

### Operations

| Record | Owner | Needs from elsewhere |
| --- | --- | --- |
| manifest, dependency, lockfile | the manifest/lock file | nothing |
| dockerfile, image, compose-service, k8s-deployment, k8s-service, port, probe, healthcheck | the Dockerfile, compose or Kubernetes file | nothing beyond the file, except a service name from the unit index |
| env-definition, env-var | the environment file | the env reads of the code files (`code.reads-env`), which come from code facts |
| make-target, ci-workflow, ci-job, newcomer-* | the Makefile, the workflow, the README | nothing |
| logger, metric, metrics-endpoint, health-endpoint, process, symbol | the code file | the library effects of the file (`libraryEffectsOf`), the file's symbols (graph) |
| service | the file that declares the unit (manifest) | the files the service holds (a read by property of `code.file` and the unit index) |
| broker, channel | the file that declares them (compose, env, code constant) | the topic constants of the service (code facts) |
| the 24 edge types | the file whose span the driver gives the edge | the other end by value: a port, a service name, a topic, a dependency name |

## The three graph reads the port needs beyond what exists

1. **A bounded read of edges by a property** (`edgesByProperty(relation, field,
   value, {limit, after})`, recorded and replayed like `byProperty`): the
   contracts channel's consumer fold and the operations' endpoint links read the
   edges another unit published, and today no static stage can read an edge by a
   value. This is additive to `static-context.ts`/`static-reads.ts` exactly as
   `byProperty` was.
2. **A per-file service membership fact** — the unit a path belongs to, from the
   nearest `go.mod` or `package.json` up its folders (path-scoped reads), so a
   unit need not scan the tree for manifests. The code-facts stage can publish it
   as a `code.service-unit` node or as a property of the file's facts.
3. **A per-file port fact** — the ports a file's code listens on, by the same
   rules `portsByService` uses today (`readTsFile(...).listenerPorts`,
   `readGoFile(...).serverAddrs` with its constants, the `started` ports), so an
   operation's `service` and a route's `ports` are a read by property rather than
   a tree scan.

## Order of work

1. the two facts of §"reads the port needs" (2 and 3) and the edge read (1), each
   with its own test;
2. the data-model stage (its per-file readers are pure, and its aggregates are
   the migration ordinal and the merged table);
3. the contracts stage (the port fact unblocks the operation's `service`, the
   edge read unblocks the channel fold);
4. the operations stage (the largest: 30 kinds, 24 relations);
5. the comparison test the task asks for, per stage, against the extract driver
   on the generated training repository.

Each stage's comparison is expected to name differences only where the driver
itself is wrong; the evidence for each such claim belongs in the change record.

# Code records

Capability: code-records

## Purpose
What the graph states about the code it read (decisions 0034 and 0035): a file's language and the candidates behind an
ambiguous one, the class its catalogue declares, and the periods it existed — written as opinions by the disk and git
producers of the fill, so a page or an agent reads them like every other fact.

## Requirement: language — A file's language is read, never guessed
The disk producer shall state a file's language from the pinned Linguist dataset, with the dataset's candidates when the
extension is ambiguous; an ambiguous language shall be decided by the file's content and then by the extension's default,
a shebang shall name the language of a script no extension names, an explicit git attribute shall be kept, and a name the
dataset does not know shall be `unknown` rather than a suffix guess. A file's language and its candidates shall be
opinions: a language that changes closes the old opinion instead of adding a second answer.

### Scenario: ambiguous-and-shebang
- Given: a file whose extension several languages claim, a script whose shebang names its language, and a name no language knows
- When: the tree is read
- Then: the ambiguous file states its candidates and the content's choice, the script states the shebang's language, and the unknown name is `unknown`
  Checked by test/repository-language.test.ts

### Scenario: language-is-an-opinion
- Given: a file whose language changes between two reads
- When: the second read is published
- Then: the new language answers, the old opinion is closed, and the filter reads the field
  Checked by test/graph-records.test.ts

## Requirement: class — The catalogue declares the classes a path takes
The catalogue shall declare the file classes — code, test, documentation, dependency and generated — with the path
patterns each covers and the one that is the default, and the disk producer shall state a file's class by the first rule
whose pattern matches, else the default; with no rules declared it shall state no class rather than invent one.

### Scenario: classes-declared-and-read
- Given: the catalogue's five classes and their patterns, and a repository holding a file of each and a `node_modules` dependency
- When: the tree is read
- Then: each file states its class, `node_modules` files are `dependency`, and a manifest declaring no rules states no class
  Checked by test/file-class.test.ts

## Requirement: periods — A path's periods follow the ancestry, not the commit date
The git producer shall state each path's latest period of existence from the pinned commit's first-parent history, walked
oldest first, so a deletion ends a period and a later addition begins another; a change a merge discarded shall be no
change, and a removal made by a merge shall be stated by that merge. Where the first-parent history cannot name a period —
a path only a side branch touched — the full history shall close it. A shallow clone's boundary shall not fabricate an
addition, and the repository shall say it is shallow.

### Scenario: ancestry-order
- Given: a path deleted on a side branch with a backdated commit and merged after the trunk moved on
- When: the tree and history pass reads the pin
- Then: the period ends at the commit that really ended it, not at the commit date's order
  Checked by test/git-file-history.test.ts

### Scenario: discarded-deletion
- Given: a deletion committed on a side branch that the merge discards
- When: the history pass reads the pin
- Then: the file has no removal and its period stands, and a path only a side branch created and deleted is not current
  Checked by test/git-file-history.test.ts

### Scenario: shallow-boundary
- Given: a shallow clone
- When: the history pass reads it
- Then: no addition is fabricated at the boundary, the repository states that it is shallow, and a genuine root addition elsewhere still stands
  Checked by test/git-file-history.test.ts

## Requirement: counts — A file's commit count is the commits its edges hold
The git producer shall state a file's change count and last change from the commits whose touched edges name it, merge
commits included, so the count and the dates agree with the edges the same pass published.

### Scenario: commit-count
- Given: a file changed by ordinary commits and by a merge commit
- When: the tree and history passes read the pin
- Then: its commit count is the number of commits its touched edges hold, merge included
  Checked by test/plugin-file-facts.test.ts

## Requirement: imports — Every import a file states is an edge with its place
The imports producer shall read the TypeScript and JavaScript file vertices and their content through the graph's reads, and shall state — from a parse, never from a pattern over the text — one `code.imports` edge for an import declaration, an `export … from`, a `require()` call, a dynamic `import()` with a constant specifier, and an `import('x').T` type, and one `code.imports-package` edge for a specifier that names no file of the repository. Each edge shall repeat, told apart by the line and column of the import, and shall carry the specifier as written, the form and the imported names; its evidence shall name the repository, the path, the blob and the lines. The producer shall read a repository without silencing the host's heartbeat: a pass over many files shall yield to the event loop between files, so no silence bound is crossed however large the repository. The catalogue shall declare both edge kinds with the `imports` capability and shall key `code.package` by ecosystem and name.

### Scenario: every-form-with-its-place
- Given: a fixture repository with one file per import form, a tsconfig path alias and a package
- When: the imports producer reads the graph's files
- Then: every import is an edge with its line and column, specifier, form and names, and every package is one entity
  Checked by test/imports-read.test.ts

### Scenario: heartbeat-on-a-large-repository
- Given: a unit over eight hundred files and a host whose silence bound is one second
- When: the producer reads the repository
- Then: the unit completes, its answer names no problem, and the host records no missing heartbeat
  Checked by test/imports-heartbeat.test.ts

### Scenario: asserted-types-and-constant-templates
- Given: a `.ts` file with a type assertion and a dynamic import of a template literal without substitution
- When: the producer parses the file
- Then: the assertion is TypeScript rather than JSX and the dynamic import states its edge
  Checked by test/imports-read.test.ts

## Requirement: resolution — A specifier resolves as the repository resolves it
The producer shall resolve a relative specifier with the TypeScript and ESM extension rules — `.js` naming `.ts`, the `.jsx` substitution, index files and a folder's package entry, with `types`/`typings` before `main` — and shall apply the tsconfig nearest the importing file: a bare name only when the effective `baseUrl` is declared or inherited, one `paths` pattern (exact, then the longest prefix) whose targets are anchored at the effective `baseUrl`, and a child's `paths` replacing the inherited ones. A relative specifier that names a file outside the repository shall not be redirected inside it.

### Scenario: package-entry-and-aliases
- Given: a folder whose package states main and types, and a tsconfig whose paths overlap and whose child replaced the inherited ones
- When: the producer resolves the specifiers
- Then: the types file answers, the exact or longest-prefix alias answers, the inherited alias is gone, and no less specific pattern answers
  Checked by test/imports-read.test.ts

### Scenario: baseUrl-and-outside
- Given: a config without baseUrl, a root file with the same name as a package, and an import of a path above the repository root
- When: the producer resolves the name and the outbound path
- Then: the name is the package and the outbound path is unresolved with its place
  Checked by test/imports-read.test.ts

## Requirement: problems — A file the reader cannot read is a problem, never a silence
The producer shall state a file the parser refuses, a file whose content the graph does not hold, and a relative specifier no file answers as problems carrying the repository, the path, the line, the column and the cause; the rest of the answer shall stand, and a partial unit shall keep these problems beside the general cause. A relative specifier no file answers shall also be an edge to the path it names, so the graph records an unresolved reference with the import's place.

### Scenario: unparseable-and-unresolved
- Given: a repository holding an unparseable file, a file the host does not answer and an import no file answers
- When: the fill runs the producer
- Then: the outcome is completed, its reason names each place, the other files' imports publish, and the unresolved import is a graph reference
  Checked by test/imports-path.test.ts

### Scenario: partial-keeps-problems
- Given: a producer answering partial with file problems
- When: the host records the unit
- Then: the outcome names the general cause and every file problem with its place
  Checked by test/plugin-partial-problems.test.ts

## Requirement: order — A plugin's reads orders its turn; derives-from names what the concept rests on
A kind's `derives-from` shall name the kinds its concept rests on, never the source one producer reads. The fill shall plan a plugin's turn after the producers of the kinds the plugin reads, following reads and derives-from recursively, and shall consider only the outputs that run after gap coverage.

### Scenario: reads-order-the-turn
- Given: a plugin reading `code.file` whose output kind declares no derives-from, and a kind whose only other producer is a suppressed gap producer that reads another kind
- When: the fill is planned
- Then: the reading plugin runs after the file producer, and the suppressed producer's read is not selected
  Checked by test/plugin-fill-declarations.test.ts

## Requirement: schema — The published schema carries the imports
The published GraphQL schema shall derive from the catalogue the two edge kinds with their fields and both directions, and the `code.package` entity's ecosystem and name; the starter schema shall derive with no kind refused.

### Scenario: starter-carries-imports
- Given: the starter catalogue
- When: the starter schema is derived
- Then: graphql-js accepts it, it holds the import edges and the package fields, and no kind is refused
  Checked by test/graphql-starter.test.ts

## Quality requirements
- A read is bounded and deterministic: the same pin and contract state the same records, byte for byte.
- Every date is Git's own clock with its offset, never a conversion to UTC that drops the offset.

## Context
Decisions 0034 (one graph, every kind a table) and 0035 (the producers state opinions); madarch-64o5.65, .66 and gzaz
(the code data these requirements state).

## Coverage limits
No producer states a file's symbols or its call graph here; those are the code structure kinds' own.

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

## Quality requirements
- A read is bounded and deterministic: the same pin and contract state the same records, byte for byte.
- Every date is Git's own clock with its offset, never a conversion to UTC that drops the offset.

## Context
Decisions 0034 (one graph, every kind a table) and 0035 (the producers state opinions); madarch-64o5.65, .66 and gzaz
(the code data these requirements state).

## Coverage limits
No producer states a file's symbols or its call graph here; those are the code structure kinds' own.

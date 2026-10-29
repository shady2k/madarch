# The Problems page covers the whole product: deterministic findings in the code, in the documents and in the wiki

Change: madarch-m38l.19
Base: 1b55fdf3bde8
Tasks: madarch-m38l.19
Kind: behavior

## Intent
The Problems page showed only what the wiki could see of its own pages. A reader could not see the product's other defects: a dependency cycle, unparameterised SQL, a route outside the auth group, a large file or a change hotspot, a dead export, a TODO or FIXME, a required setting checked in with a development value, a declared-unused or used-undeclared dependency, a contract operation with no route or a route outside the contract; nor contradictions, stale grounds and undocumented behaviour already written down as questions; nor the wiki's own broken grounds, unread pages and manifest findings in one place. This change makes the page one listing of the whole product, in three sections, with the same shape for every finding.

## Rationale
The page is a read over facts the code, contract, environment, dependency and document extractors already store, plus the loop's own question files. It needs no agent run and no new extraction. The rules are data: a product switches one off or changes its severity in `madarch/kinds.yaml`, and the thresholds for large files and hotspots are there too. The SonarQube taxonomy (vulnerability, bug, code smell, security hotspot; blocker to info) gives one vocabulary for findings of every kind. A problem's id is its rule and identity, never its position, so a dismissal stays with the same problem across a refresh and a task can be recreated from the same finding.

## Changes
- `src/problems/types.ts`: the section, Sonar kind and severity, links, drafts, scopes, rule data and default thresholds; `problemId(rule, identity)`.
- `src/problems/rules.ts`: the 26-rule catalogue with its early severity and label in both languages; `ruleForKind` keeps the existing wiki findings' old meanings.
- `src/problems/code.ts`: the deterministic code rules over one graph snapshot: cycles, SQL input path, routes outside the auth group, large files, hotspots, dead exports, TODO and FIXME, required settings with a checked-in value, declared-unused and used-undeclared dependencies, contract operations and routes. A failed rule is a note, not a smaller page.
- `src/problems/documents.ts`: contradictions, ambiguous terms, undocumented behaviour and gaps, and stale grounds, from the existing questions; a resolved question is no longer a problem.
- `src/problems/index.ts`: collects the three sections and gives each draft its stable id.
- `src/extract/code/{keys,index}.ts`: `code.debt` nodes, read only from syntax-tree comment nodes; a string that spells TODO is not a marker. The starter set declares `code.debt` so the finding has an entity page.
- `src/knowledge/kinds.ts` and `src/knowledge/seed.ts`: the manifest's `problems:` block (`rules`, `thresholds`), validated with file and line, and written with every default in the starter manifest.
- `src/loop/views.ts`: one `Problem` shape with section, rule, Sonar kind, severity, place, entity, evidence, scope and id; the legacy wiki findings keep their kinds; a manifest finding is `wiki.manifest`. The listing counts each section and dismissals, and sorts stably.
- `src/loop/problem-files.ts`: «Не проблема» records under `docs/problems/<rule>-<hash>.md`; the person's reason is front matter and the body; a malformed record is a finding.
- `src/knowledge/product.ts` and `src/server/{knowledge,http}.ts`: the listing, `POST /api/k/problem-dismiss`, `POST /api/k/problem-task`; a page's badge is counted after its transaction; a task opened from a problem records the problem id in its file.
- `wiki/app/src/knowledge/{loop.tsx,api.ts,types.ts,pages.tsx}` and the locales: the three sections, rule/Sonar/severity words, place, entity, evidence path, «Создать задачу», «Не проблема» and the entity-page badge.
- `src/knowledge/doc-sources.ts`: `docs/problems/` records are loop files, not documents the wiki reads.

## Preserved contracts
- The old `problems` array and the old wiki `kind` values remain; the new rule, section, Sonar and severity fields are added.
- `madarch/kinds.yaml` gains an optional `problems:` block; a manifest without it reads as before.
- A task's file format gains an optional `problem`; tasks from answers are unchanged.

## Known limits
- A code fact set read short is named in the listing's notes; the unread rows are not judged.
- The code rules read the pinned graph; a rule that cannot run adds a note and never hides the other rules.
- A dismissal is matched by exact stable id: a material change to the finding's identity lists it again.

## Acceptance evidence
`out/report.md` records every command, its exit code and counts. The red and green tests are `test/problems-rules.test.ts`, `test/problems-documents` coverage in that file, `test/problems-manifest.test.ts`, `test/problems-wiki.test.ts`, `test/problems-dismissal.test.ts`, `test/extract-code-units.test.ts`, `test/loop-server.test.ts`, `test/loop-refresh.test.ts` and the wiki app's `loop.test.tsx` and `readers.test.tsx`.

## DONE WHEN
The Problems page has the three sections over the whole product; each row shows its rule and Sonar kind and severity, a place and entity link, one plain-language reason and an evidence path; «Создать задачу» opens a task scoped to the place and «Не проблема» keeps the reason as a file of the product; the entity page shows the badge; and every rule is data the manifest can tune, with a test.

# Questions, corrections and an incremental refresh close the loop: the agent asks, a person answers in the wiki, the next refresh edits only the pages that need it

Change: madarch-m38l.7
Base: be87639c11effd73665143104ead27ff7187b393
Tasks: madarch-m38l.7
Kind: behavior

## Intent
Decision 0029 says people edit source entities and the agent rewrites the text. This change gives the loop its entities. While writing, an agent unit records what it could not ground, or where sources disagree (a document says one thing, the code another; a term used two ways), as a question: a Markdown file a file in `docs/questions/` in the product repository, written through a new bounded tool `ask_question`. A person answers in the wiki; the answer is written into the same file with the author from git `user.name`/`user.email`, the time and the mark "local, not verified" (decision 0031), and committed in the product repository with that author. A person who finds a statement wrong records a correction, a file in `docs/corrections/`. A page lists the open questions, and another the problems: corrections and what the engine found (an unresolved ground, a broken link), with who fixes each.

"Обновить" no longer rewrites everything. The engine decides which pages need an agent unit: pages whose grounds changed or were removed (`changedGrounds`), pages touched by an answered question or a correction, pages named by new domains. Only those get a unit; the unit is given the current page and what changed (old and new text of each changed ground, the answer or the correction) and is told to edit, keeping every sentence and footnote name whose grounds did not change. Unchanged pages cost no agent run. A change of content language rewrites all pages as a translation that keeps the grounds. Before the agent starts, the wiki shows which pages will be touched and why.

## Out of scope
- The correction entry on a statement page: the statement page is madarch-m38l.6's. This change delivers `POST /api/k/correction` (a statement and a reason) and the file it writes; the entry is wired after m38l.6 merges.
- A real agent run: it needs the owner's explicit yes with the agent and the cap.
- Server identity (OIDC, verified authors): decision 0031 leaves it to the server milestone; every write here carries "local, not verified".
- Unrelated services as new domains found by a refresh: the product unit runs when a service appeared after the product page was written and no page names it, and declares what it finds; no other detection of new domains is made.

## Preserved contracts
- product-wiki/serve: the routes of the knowledge wiki keep their addresses and answers; the new ones are added.

## Coverage
- product-wiki/questions: test
- product-wiki/corrections-and-problems: test
- product-wiki/incremental-refresh: test
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: the knowledge wiki of the training product: «Вопросы» and a question's page, «Проблемы», the refresh menu and the card of a running refresh
Mockup: docs/prototypes/madarch-m38l.7/en-02-question-open.png

1. After the agent wrote the pages, the sidebar's «Вопросы» lists the questions it asked (open first); a question's page shows both sides with their grounds as links and a form to answer.
2. The person types an answer and saves it: the page shows the answer with the author and "local, not verified", and says the next refresh uses it.
3. The refresh menu lists the pages the agent will edit and why, and how many it leaves alone; after the press the card of the run shows the same plan before the first unit.
4. After the refresh the question shows as closed by the page that used its answer; «Проблемы» lists corrections and what the engine found, each with who fixes it.

## Blocking questions
None.

## Design and decisions
Decisions 0029 (people edit source entities, the agent rewrites), 0030 and 0031 (identity is git locally). Choices inside them:
- **Reserved kinds.** `question` and `correction` are declared in the product's manifest like any kind (`docs/questions`, `docs/corrections`, templates in `templates/`); the starter set carries them and a refresh adds them to a product made before (`ensureLoopKinds`, comments of the manifest kept). The engine's pages «Вопросы» and «Проблемы» are keyed by these two names; the generic kind pages for them are not shown, and an entity link to one opens the loop's page.
- **A question is a file in the page format.** Front matter (`id`, `kind`, `title`, `type`, `status`, `about`, `asked-in`, `asked-at`, `written-at`; once answered `answered-by`, `answered-at`; once a rewrite used it `resolved-by`, `resolved-at`), `## Question`, `## Why it matters`, `## What the sources say` (each side one sentence ending in a footnote that lists its grounds, so the index makes statements of them) and `## Answer` (a quotation, so no line of the answer is read as a heading). The tool refuses a ground that does not resolve, a contradiction with one side, a title that names nothing, a repeated id and a seventh question, listing every problem at once.
- **Answers and corrections are committed as the person.** Identity is `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, else `user.name`/`user.email` of the product repository; none is a refusal that says what to run. The mark is `verified: local, not verified` in the front matter and in the file's last line. A file that was written but not committed (not a repository, a hook refused) says so in the answer to the request. Two answers at once make one.
- **The refresh plan** (`src/loop/plan.ts`) is a pure rule over the pages as the index reads them, `changedGrounds`, the question and correction files and the services of the graph. A page needs a unit when it is missing, the language changed, a statement of it stands on a ground that changed or is gone, an answered question or open correction is about it (by page id, statement, or a graph key/section one of its statements stands on), or, for the product page, a service appeared after the product page was written and no page names it. An answer or correction about no page is returned in `unplaced`. The worker computes the plan after the code is read and sends it (`plan`) before it asks for the agent; the server also computes it from the graph as it stands for `GET /api/k/refresh-plan`, counting the commits not read yet.
- **The unit edits.** Its prompt carries the page, the old and new text of each changed document section (a diff of the file for a code ground, the old head of a removed file), the answer with its author, the correction with its reason, bounded (3 000 characters a ground, 30 000 in all, the rest counted). The existing check keeps the footnote name of a sentence that stands unchanged. The runner skips the product unit when only domain pages are planned, declaring the domains from their pages, and reports kept pages as kept.
- **Closing.** A sentence may stand on a `madarch:question:` link (answered) or a `madarch:correction:` link; any other entity page is refused as a ground. When every page an answer or correction touched was written, the file gets `resolved-by`/`status: applied` (not committed, like a page the agent writes), and the question shows as closed.
- **Index.** `about` is read as `relates`; an answered question also indexes an `answer` page; a statement is addressable as page id, hash and name by corrections and questions.
- **Limits.** A page rewritten by a person by hand is not detected as a changed ground. A symbol ground's change is shown as a diff of its file. The "new domain" trigger is the new-service rule only.

## Acceptance evidence
Run on the SkyPilot pod (`madarch-sky-test`), fixtures only:
- test/loop-training.test.ts, the generated training repository through the production path (server, fill worker, fake ACP agent behind an adapter on the PATH): the agent filed seven questions, one for each of the answer key's `contradiction.discount`, `contradiction.tax`, `contradiction.retention`, `behavior.retention-undocumented`, `contradiction.outbox-timing`, `term.payment-token` and `payments.refund-no-resilience`, each grounded in every place the key names for its item (every ground resolves); a person's answer to the payment-token question landed in its file in `docs/questions/` and in a commit authored by the person; the refresh plan named one page (the payments page) and two as unchanged; the refresh ran one unit, left the product and ordering pages byte for byte as they were, kept the payments sentence and its footnote name, added one grounded in the answer, and the question showed as closed by `domain:payments`; the next plan was empty.
- test/loop-refresh.test.ts over a small repository: ask_question's refusals, bounds and the question's place in the index; a refresh with nothing changed runs no unit; an answer edits one page; a changed README section edits only the page standing on it, with the old and the new text in the prompt; a section that is gone is listed as a problem for the agent; a language change translates every page; after a rewrite the grounds read as unchanged and the next plan is empty.
- test/loop-entities.test.ts (files, answers committed as the person, refusals, concurrency, links out of the product, the plan's rules), test/loop-server.test.ts (the routes), wiki/app/src/knowledge/loop.test.tsx (the pages in both languages).
- Screenshots of the walk in English and Russian (scripts/loop-shots.ts: the questions, a question and its form, the answer, the refresh menu with the plan, the card of the running refresh with the plan, the question closed, the problems before and after, a phone and the dark scheme) were looked at and fixed (the closed problem said "fixes it at the next refresh"; the run's message listed question ids); three are kept in docs/prototypes/madarch-m38l.7.
- A read-only review by Codex found eleven defects, all fixed with tests: a cross-origin form could post an answer (writes now need a JSON content type), a folder that is a link out of the product was written through, two corrections at once chose one file, an answer could close before every planned page was rewritten or when its note did not fit the prompt, an answer was read as a source side, a claim with code marks changed when answered, a question could carry the file's own headings, a missing domain was not in the plan, a commit failure's note vanished with the form, and a removed service counted as new.

Known limits:
- The full suite was run on CI, not on the pod (the pod's 4 GB stopped it); the focused suites above ran on the pod.
- A page a person edited by hand is not seen as a changed ground; a code ground's change is a diff of its file.

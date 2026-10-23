# Questions, corrections and an incremental refresh close the loop: the agent asks, a person answers in the wiki, the next refresh edits only the pages that need it

Change: madarch-m38l.7
Base: be87639c11effd73665143104ead27ff7187b393
Tasks: madarch-m38l.7
Kind: behavior

## Intent
Decision 0029 says people edit source entities and the agent rewrites the text. This change gives the loop its entities. While writing, an agent unit records what it could not ground, or where sources disagree (a document says one thing, the code another; a term used two ways), as a question: a Markdown file `docs/questions/<slug>.md` in the product repository, written through a new bounded tool `ask_question`. A person answers in the wiki; the answer is written into the same file with the author from git `user.name`/`user.email`, the time and the mark "local, not verified" (decision 0031), and committed in the product repository with that author. A person who finds a statement wrong records a correction, `docs/corrections/<slug>.md`. A page lists the open questions, and another the problems: corrections and what the engine found (an unresolved ground, a broken link), with who fixes each.

"Обновить" no longer rewrites everything. The engine decides which pages need an agent unit: pages whose grounds changed or were removed (`changedGrounds`), pages touched by an answered question or a correction, pages named by new domains. Only those get a unit; the unit is given the current page and what changed (old and new text of each changed ground, the answer or the correction) and is told to edit, keeping every sentence and footnote name whose grounds did not change. Unchanged pages cost no agent run. A change of content language rewrites all pages as a translation that keeps the grounds. Before the agent starts, the wiki shows which pages will be touched and why.

## Out of scope
- The correction entry on a statement page: the statement page is madarch-m38l.6's. This change delivers the API and the correction file it calls.
- A real agent run: it needs the owner's explicit yes with the agent and the cap.

## Preserved contracts
- product-repository/manifest: the manifest is read as before; the new kinds are declared in it like any kind.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: page
Place: the knowledge wiki's «Вопросы» and «Проблемы» pages, a question's page, and the refresh preview on the product's home page
Reason: the owner asked where the open questions are and what to do with the problems found.

1. A person opens «Вопросы», opens a question and types an answer; the answer lands in the question's file and is committed.
2. A person presses «Обновить»; the wiki lists the pages it will touch and why, then the agent edits only those.

## Blocking questions
None.

## Design and decisions
Written with the code; see the sections below as they are filled.

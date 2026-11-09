# Every route names its tab

Change: madarch-u3vw.12
Base: 45733961179846613381f9b9eb2fe2c9dbf676d1
Tasks: madarch-u3vw.12
Kind: no-behavior

## Intent
The tab of a page stayed «Загрузка…» when the view never named it. The page of a product whose home is its repository —
the demo's home — the folder, file, commit and run pages, and the fill page had no `useTabTitle` call, so the tab bar
kept the loading placeholder the tab starts with; a task whose read failed named nothing either. Every route now names
its tab once it has rendered: the repository page by its repository, the folders by their paths, a file by its path, a
commit by its subject (or its hash when the read failed), the run and fill pages by their own titles, and a failed task
by the words that say the tasks could not be read. A page whose title is not known until its data arrives still shows
«Загрузка…» while the read is pending, and gives way to the page's name when it lands.

## Out of scope
- The tab bar's behaviour, the titles of pages that already named themselves, and the words of any page.
- The browser's own document title.
- A page whose route the wiki refuses: it keeps the loading name only until it renders its own error name.

## Changes to requirements
None. The shell already requires the current page to be marked in the navigation and the tabs to carry the page they
hold; this change makes every view name itself.

## Preserved contracts
- product-wiki/shell: every opened page stands as a tab, a tab names the page it holds, and a page still reading says
  it is loading; plain clicks, new tabs, Back and Forward behave as before.

## Coverage
- product-wiki/shell: test, `wiki/app/src/knowledge/entities.test.tsx` — a walk of every route kind (the empty home, a
  filled home, a repository home, an entity, a missing entity, a kind, a source, a folder, a file, a commit, a run, the
  documents, a document, the catalogue, the glossary, questions, a question, problems, settings, the journal, the fill,
  tasks, a task and a statement) asserts that no tab's title is the loading text after the page stands, and one case
  asserts the loading text still shows while a read is pending.

## Where it is seen

Kind: internal
Place: the tab bar of a served product wiki, on every route
Reason: the change corrects the name the shell already promised a tab; no new screen, command or message is added.

1. Open the demo's home (a filled product whose home is its repository) and read the repository's name on the tab, not
   «Загрузка…».
2. Open a folder, a file, a commit, the run page and the fill page, and read each page's own name.
3. Open a page whose read is pending and see «Загрузка…» until the page names itself.

## Blocking questions
None.

## Design and decisions
Each view names its tab through `useTabTitle`, as every other page of the wiki already did. The title a route knows from
its address (a folder path, a file path, a source file name) is written at once; one that only the read can supply (an
entity or document title, a commit subject) is written when the data arrives, and its error words when the read fails.
The walk is one test per route render through the app root with the server's shapes stubbed.

## Acceptance evidence
- `wiki/app/src/knowledge/repository.tsx`, `fill-page.tsx` and `loop.tsx`: the missing calls and the task's error name.
- `wiki/app/src/knowledge/entities.test.tsx`: the route walk and the loading case.

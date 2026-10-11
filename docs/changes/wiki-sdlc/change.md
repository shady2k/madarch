# The wiki shows the product's life cycle: every SDLC stage from the real files

Change: wiki-sdlc
Base: 7d9ac8015e0902b28303b26cbef80980fdb2b781
Tasks: madarch-iuc.16
Kind: behavior

## Intent
The owner set the target: an engineer opens the product's wiki and works by
any stage of the SDLC. After this change the wiki's app shows the stages of
the skill set's life cycle — Idea, Requirements, Design, Build, Verify,
Release, Operate — as sections in that order, one page per stage, each read
from the real files the skills write: the product documents under their kind
folders on the Idea, Requirements and Design stages; the product's tasks on
Build, read only from the tracker's own export `.beads/issues.jsonl` and
grouped by the feature each task hangs under; the acceptance records the
set's gate writes under its records folder on Verify; the Release stage
reads the project's changelog — the first of the two usual spots (Keep a
Changelog's is the common form), never both, and never the change proposals
under `docs/changes/`, which are not releases until they land; the Operate
stage holds none of
`handle-incident`'s material here and says so — the skill's review turns
into tracked work and lessons kept where every agent reads, not into a
folder. A stage that holds nothing of a kind names the skill that fills it,
in a quiet line — no dead control anywhere: an artifact whose path the page
reader does not serve stands as text, never a link that cannot open. The stages navigate: where a stage's material belongs
to another feature's section — the Architecture section of the model views,
the Repositories section of the code repositories — the stage links to it
and never duplicates it, and where the Idea or Requirements kinds overlap
the document kinds the wiki already serves, the stage links to those same
pages. The stage wording rides the same English and Russian catalogues as
the rest of the chrome.

## Out of scope
Compiling the product's model or rendering the Architecture section (the
diagrams change), listing or cloning the code repositories (the repositories
change), running the set's product check on the pages, writing anything to
the product or its tracker, and any stage the set's life cycle does not
carry.

## Rationale
The wiki answered "what does this document say"; the owner's target is "what
does the product hold at this stage, and what is missing". The stages are
the set's own life cycle, so the wiki reads the same places the skills write
and names the same skills as the way to fill a gap. The tracker export is
read exactly as the tracker writes it, so no second form and no writes are
introduced; a product without an export simply shows the Build stage's
missing line.

## Changes to requirements
- product-wiki/stages: new requirement — the served wiki shows every stage of
  the life cycle in order from the product's real files, with the Build
  stage's tasks read-only from `.beads/issues.jsonl` grouped by feature,
  every mended or dropped row surfaced at its full path and line, the
  acceptance records and the release notes (the first changelog that
  exists — the change proposals under docs/changes/ are never releases)
  from the places the skills actually write, a quiet line naming
  the filling skill for every kind a stage holds nothing of, refusals of
  unreadable places named with their full path, the other features'
  sections named — linked where the serving build holds their routes, quiet
  text until then — and both catalogue languages.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/reading-typography: test
- product-wiki/architecture: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test
- product-wiki/describe-guide: test

## Coverage
- product-wiki/stages: test, mutation, browser-walk
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/reading-typography: test
- product-wiki/architecture: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test
- product-wiki/describe-guide: test

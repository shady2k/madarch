# The wiki shows the product's life cycle: every SDLC stage from the real files

Change: wiki-sdlc
Base: 36aeb263c60c918c0364f810b0f8a6d63d240867
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
set's gate writes on Verify; the release records of `ship-release` on
Release; the incident records of `handle-incident` on Operate. A stage that
holds nothing of a kind names the skill that fills it, in a quiet line — no
dead control anywhere. The stages navigate: where a stage's material belongs
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
  stage's tasks read-only from `.beads/issues.jsonl` grouped by feature, the
  acceptance, release and incident records from the places the skills write,
  a quiet line naming the filling skill for every kind a stage holds nothing
  of, refusals of unreadable places named with their full path, links to the
  other features' sections instead of duplicates, and both catalogue
  languages.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/reading-typography: test
- product-wiki/internationalization: test

## Coverage
- product-wiki/stages: test, mutation, browser-walk
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/reading-typography: test
- product-wiki/internationalization: test

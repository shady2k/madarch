# The manifest's code repositories in the wiki

Change: wiki-repos
Base: 01eca2e44ab09182b23526f2b521f5674984f467
Tasks: madarch-iuc.14
Kind: behavior

## Intent
The owner ordered (madarch-iuc.14, note-sdlc.md, 2026-10-11): from the
product's manifest (`workspace.yaml`, `repos`) the wiki gains a
"Repositories" section — each repository with its name, url, branch, whether
it is checked out under `repos/`, its README rendered, and its last commit —
"so the engineer sees the code side next to the documents". The manifest's
reading is the pinned program's; the commands themselves are the onboarding
run's and are not changed here. A product whose manifest declares no
repositories shows nothing new: no empty stub, no dead link.

## Out of scope
Cloning, bootstrapping or any write to a checkout (the `madarch repo add`,
`bootstrap` and `clone` commands stay the onboarding run's); showing anything
from a checkout beyond its HEAD and root README; the editor's use of the
repositories (madarch-j0a); a sync or refresh control.

## Rationale
A product's knowledge sits apart from its code, and the wiki so far showed
only the documents half. The manifest already names the repositories the
product spans; reading them into the wiki closes the gap without a new
manifest field, a new command or any write to a checkout.

## Changes to requirements
- product-wiki: the new requirement `repositories` — the declared code
  repositories shown at `/r` from a sidebar entry, each with its checkout
  state, HEAD and rendered README; the section exists only where the
  manifest declares repositories.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test

## Coverage
- product-wiki/pages: test
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test
- product-wiki/repositories: test, mutation, browser-walk

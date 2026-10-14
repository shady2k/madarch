# Design — serve an empty directory for its getting-started home

## Context and drivers

`readProduct` makes `workspace.yaml` the recognition boundary. `serveWiki`
currently calls it before building or starting the app, so a directory without
a manifest cannot reach the app's empty-home guide. The issue requires both a
blank folder and a folder without a manifest to serve that guide. The reader
and all lifecycle commands remain strict; no product data may be created.

The outcome is for a person with an empty folder to learn how to start or
connect a product. A quality scenario is: an existing empty directory with no
manifest is passed to `madarch serve`; the command serves the current wiki
home with the guide in English or Russian, and the directory's files before
and after serving are identical. Failure scenarios: a missing/non-directory
path, a present but unreadable manifest entry, and a malformed or unsupported
manifest stay refused, with no fallback. The normal product path must remain
unchanged.

Constraints from the owner-approved task: this is serving behavior only;
`readProduct`, manifest validation, lifecycle commands, manifest-driven
completeness and product data do not change. The fallback is read-only.

## Inventory

- `src/product/manifest.ts:464-479` reads `workspace.yaml`; a read failure
  becomes a refusal. Since a dangling symlink can also report `ENOENT`, a
  serving fallback must inspect the directory entry itself before deciding it
  is absent.
- `src/product-wiki/serve.ts:126-161` refuses the reader result before building
  or starting the app.
- `src/product-wiki/pages.ts:158-184` exposes `ProductIdentity` on the
  `ProductWiki`; `src/server/http.ts:164-172` opens it. `ServerOptions` is
  the call path from `serveWiki` to `openProductWiki`.
- `/api/product` currently returns a required id; `wiki/app/src/api.ts`
  types it as required. The shell needs a name and page list, not an id. The
  wiki's model reader needs the folder; its repository reader needs the folder
  and declared repositories.

## Options from named patterns

1. **Special Case (PoEAA), at the wiki-opening boundary — chosen.** Keep
   `readProduct` strict. Add an explicit, default-off serving option for a
   missing manifest. Accept it only when the product folder is an existing
   directory and `lstat(workspace.yaml)` returns `ENOENT` (not when a dangling
   symlink or unreadable entry exists). Give the wiki a manifestless display
   identity with `name = basename(folder)`, `folder`, no `id` and no declared
   repositories. Its API omits `id`; the basename is
   not represented as a product identity. No file is written. This reuses the
   existing app/API and keeps invalid manifest errors intact. Cost: the wiki
   reader needs a small manifestless identity variant and the opt-in must stay
   limited to `madarch serve`.
2. **Page Controller / server-rendered fallback page.** Keep ProductWiki
   strict, but return separate HTML and translations at the server boundary
   for a manifestless folder. This avoids a temporary wiki identity, but
   duplicates the app's page, localization and behavior and does not use the
   established `/api/product` + `/api/pages` route. It increases drift risk.
3. **Reject a manifestless folder (current behavior).** This follows the
   `Product Repository` contract without a special case, but directly fails
   the task's `madarch serve` acceptance scenario.

The alternatives are compared against the same service and failure scenarios:
option 1 reuses the app and leaves reader/lifecycle semantics intact; option 2
makes the fallback visually diverge and duplicates translations; option 3
fails the required outcome. Option 1 is selected.

## Decision and mechanism

Use option 1. `serveWiki` checks that the path is an existing directory and
that `lstat(workspace.yaml)` reports `ENOENT`, so a dangling `workspace.yaml`
symlink is not mistaken for absence. It passes `allowNoManifest: true` through
`startServer` to `openProductWiki`; the option defaults to false and all other
callers keep strict behavior. A discriminated `ProductWikiIdentity` is either
manifest-backed (with id) or manifestless (folder, temporary basename name,
no id, no repos). `/api/product` omits id for the manifestless variant, and
the app API type permits this absence. Model and repository readers receive
only the fields they need. Existing Markdown, if present, stays the only page
content read; no sample document or manifest is created. Invalid, unreadable
or unsupported manifests retain their refusal. `madarch new` and other
lifecycle commands keep using strict `readProduct`.

## Scenarios and checks

- Given an existing empty directory without `workspace.yaml`, when
  `madarch serve` runs, then its address answers the wiki home and the
  localized guide; `/api/product` has a display name but no id; `/api/pages`
  is empty; and a before/after file listing is identical. Check: serve test
  and rendered browser walk in both locales.
- Given a directory without a `workspace.yaml` entry but with existing
  Markdown, when `madarch serve` runs, then existing pages are shown and no
  product data is added. Check: focused wiki-opening test.
- Given a missing path or non-directory path, when `madarch serve` runs, then
  it refuses the path. Check: refusal test.
- Given a present but unreadable manifest entry (including a dangling
  symlink), malformed manifest or unsupported version, when `madarch serve`
  runs, then it refuses rather than entering fallback. Check: refusal tests.
- Given a valid manifest, when `madarch serve` runs, then the manifest's name,
  id and repositories are still used. Check: existing serve test.

## Consequences and assumptions

The no-manifest display name is derived from the directory basename only for
that server process; it is not an id, is not persisted and is not passed to
manifest-aware lifecycle operations. If setup creates `workspace.yaml` while
the no-manifest server is running, restart `madarch serve` to open the product
through the normal strict reader. Serving does not create directories or
files.

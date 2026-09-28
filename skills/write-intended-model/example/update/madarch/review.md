# Review: the receipts repository at commit BRANCH_COMMIT

This model was written the way `write-intended-model` prescribes and
updated on the branch the way its update mode prescribes: the documents
read first, each claim checked in the code, every element, interface and
relation evidenced at the commit it was read from. The placeholders
COMMIT and BLOB:<file> stand for the first run's values; BRANCH_COMMIT
and BRANCH_BLOB:<file> stand for the branch's. The skill's test
substitutes them; a real run computes them.

## Claims

| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The clerk scans paper receipts into `inbox/` and receipts imports every PDF there | README.md | 3-5 | COMMIT | BLOB:README.md | `src/index.ts:10-12` | confirmed | importer |
| Receipts are kept so they can be looked up again by id | README.md | 5 | COMMIT | BLOB:README.md | `src/store.ts:11-16`, `src/lookup.ts:4-5` | confirmed | archive |
| receipts is one Bun process written in TypeScript | docs/architecture.md | 3 | COMMIT | BLOB:docs/architecture.md | `package.json:2-7`; every file under `src/` is TypeScript | confirmed | receipts |
| The importer reads every PDF the clerk leaves in `inbox/`, parses each one, and extracts the vendor, the date and the total | docs/architecture.md | 7-8 | COMMIT | BLOB:docs/architecture.md | `src/importer.ts:5-11` | confirmed | importer |
| The Cleaner removes duplicate receipts before they reach the archive | docs/architecture.md | 10 | COMMIT | BLOB:docs/architecture.md | `src/index.ts:1-15`, `src/importer.ts:1-11`, `src/store.ts:1-17`: no Cleaner and no duplicate check anywhere | contradicted | importer |
| Imported receipts go to the archive, from which the lookup command reads one receipt by id | docs/architecture.md | 14-16 | COMMIT | BLOB:docs/architecture.md | `src/index.ts:13`, `src/lookup.ts:4-5` | confirmed | archive |
| A receipt is searchable within a minute of the scan | docs/architecture.md | 15-16 | COMMIT | BLOB:docs/architecture.md | nothing in the code states or measures a delay | unconfirmed | — |
| Phase 2 mirrors the archive to S3 for off-site backup | docs/architecture.md | 20 | COMMIT | BLOB:docs/architecture.md | announced plan; nothing in the code mirrors anything | planned | — |

## Undocumented

- The webhook module and the accounting system: after each receipt is
  stored, `src/index.ts:14` posts it to the URL named at
  `src/notify/webhook.ts:4`. No document mentions the folder `src/notify/`,
  the module, or the accounting system. Modelled as `webhook` and
  `accounting`; the folder is assigned to `webhook` in the assignment table.

## Assignment

| Path | Element | Reason |
| --- | --- | --- |
| `madarch/` | excluded | the model and its review |
| `README.md` | receipts | the system's README; read for claims |
| `docs/` | receipts | the architecture document; read for claims |
| `package.json` | importer | the manifest; names the entry point and the lookup command |
| `src/index.ts` | importer | the entry point; the import loop |
| `src/importer.ts` | importer | the receipt parser |
| `src/store.ts` | archive | the archive, its writer and its reader |
| `src/lookup.ts` | archive | the lookup command; the archive's read path |
| `src/notify/` | webhook | no document mentions it; found in the code (see Undocumented) |
| `src/export/` | export | the folder the branch adds; the entry point imports it (see the update section) |

## Problems

From the model check (method and source as it reports them):

- trust-boundary-crossing (ids: `accounting`, `webhook`, `webhook-posts`):
  relation "webhook-posts" crosses a trust boundary: "webhook" sits in zones
  internal, "accounting" sits in zones internet — examine it for tampering,
  information disclosure and denial of service. Method: STRIDE per element:
  data flow across a trust boundary (examine tampering, information
  disclosure, denial of service). Source: S. Hernan, S. Lambert, T. Ostwald,
  A. Shostack, Uncover Security Design Flaws Using the STRIDE Approach (MSDN
  Magazine, 2006).
- trust-boundary-crossing (ids: `accounting`, `webhook`, `webhook-posts`):
  relation "webhook-posts" transfers data marked "confidential" to the
  external element "accounting" — examine it for tampering, information
  disclosure and denial of service. Method: STRIDE per element: data flow
  across a trust boundary (examine tampering, information disclosure,
  denial of service). Source: S. Hernan, S. Lambert, T. Ostwald,
  A. Shostack, Uncover Security Design Flaws Using the STRIDE Approach
  (MSDN Magazine, 2006).

Questions a reader of the pages raises:

- The webhook is posted over plain http to `accounting.internal`
  (`src/notify/webhook.ts:4`): should the accounting system's webhook be
  https, given the receipt carries personal data?
- The archive keeps receipts only for the life of the process
  (`src/store.ts:9`): is that the intended durability of a system whose
  documents call it an archiver?
- The export file `receipts.jsonl` is written beside the code and never
  cleaned up or archived (`src/export/writer.ts:6`): is a growing file at
  the repository root the intended home for exported receipts?

## Update BASE_SHORT..HEAD_SHORT

The branch "Export receipts as JSON Lines" adds a folder `src/export/`
that the entry point imports, and one call to it in the import loop:

- added the element `export` (module, child of `receipts`) with evidence
  at the branch's HEAD, and the relation `importer-exports`
  (`importer` → `export`), evidenced by the import line and the call
  site in `src/index.ts`;
- re-pinned four evidence items that pin `src/index.ts` — the `importer`
  element and the relations `clerk-scans`, `importer-stores` and
  `importer-notifies` — to the branch's HEAD: the lines they name moved
  with the new import and the new call;
- added the assignment row `src/export/` → `export`.

Nothing else changed: every other id, name, relation, assignment row and
evidence item stands as the first run wrote it. No document changed on
the branch, so the claims table keeps the first run's rows.

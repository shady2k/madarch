# An identity evidence target is available while its vertex exists

Change: madarch-64o5.183
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.183
Kind: no-behavior

## Intent
On a filled product the rule `evidence-applicability` reported one false problem for every `git` fact whose
evidence names a `code.commit`: the commit was in the repository, yet the fact was answered with
`availability: unavailable` and the issues `retained content is unavailable` and `declared SHA-256 digest is
unavailable or malformed`. The graph schema already tells the two kinds of evidence target apart: a
target that retains bytes declares `contentField` together with `digestAlgorithm: 'sha256'`
(`code.blob`, `system.content-snapshot`), and a target that carries identity alone declares
`immutable: true` with a key digest and no content (`code.commit`, whose `hash` is its key). The reader
treated the missing bytes of the second kind as a storage failure. After the change such a target is
`available` while its vertex exists, its historical validity stays `unknown` because the engine holds no
bytes of it, and its current applicability comes from the target's own `$exists` assertion instead of an
`evidence-support` relation the kind does not declare.

## Out of scope
- The rule `vanishedCurrentEvidence` (`src/graph/records.ts`) and the problem surface keep their
  thresholds: a stale or unavailable target is still a problem.
- The `provenance` rows the `disk` plugin earns on `code.blob` without a `code.blob-about` edge: another
  defect, another task.
- The trailing `/$bunfs/` engine paths in a problem's `cause`: stripped at the problem boundary by its own
  task, not here.
- The statement cost of `GET /api/problems` (the page-level N+1) and the deferred evidence finding of the
  same milestone.
- The public GraphQL contract and the `EvidenceState` / `EvidenceProof` types: no field is added.

## Changes to requirements
None. The change restores the behaviour decision 0039 items 19 and 31 already require — a fact is a
problem when its evidence vanished or stopped supporting the current source — and weakens no invariant:
a target with retained bytes keeps every check it had, and a target whose vertex is gone is still
unavailable.

## Preserved contracts
- graph-queries/as-of: an evidence answer is still for the asked valid and record times, keeps historical validity and current applicability independent, and reports a retracted or expired fact `ended`.
- model-check/problems: the `evidence-applicability` rule still reports a fact whose current evidence is stale or unavailable, and a fact whose target vertex cannot be found.

## Coverage
- graph-queries/as-of: static, test, mutation, review
- model-check/problems: static, test, mutation, review

## Where it is seen
Kind: request
Place: `GET /api/problems` of a product filled only by plugins, and the evidence field of a page read

1. Fill a product made from a repository with a few commits by plugins only, and read `GET /api/problems`:
   no `evidence-applicability` row names a `git` fact, where every one of them named its commit before.
2. Read a page of that product: a fact's evidence answers `historicalValidity: UNKNOWN`,
   `currentApplicability: CURRENT` and `availability: AVAILABLE` with no issue, where it answered
   `UNKNOWN`, `UNKNOWN`, `UNAVAILABLE` with three issues before.
3. Change a file and fill again: a fact whose blob changed is still reported stale, and a blob with no
   `code.blob-about` support is still reported.

## Blocking questions
None.

## Rationale
The rule was right and the state it judged was wrong: a target that declares no content field never had
bytes to retain, so reading its absence as a storage failure invented a problem for every fact naming a
commit that is present. The state is also what a reader sees in GraphQL, so fixing it at the rule would
leave the reader with the same false answer; the two expressions the schema already keeps equivalent —
`contentField` present and `digestAlgorithm: 'sha256'` present — settle which checks apply, with no new
field on `EvidenceProof` and no schema change.

## Design and decisions
`evaluateEvidenceState` names the two kinds of target with one expression, `identityOnly = proof.immutable
&& proof.digestAlgorithm === undefined`, which the schema declares equivalent to "no `contentField`": the
content and SHA-256 checks run only for a target that retains bytes, and an identity target is available
while its vertex is found. `readEvidenceStates` adds `'$exists'` to the assertion read it already makes
per kind, so one statement answers the existence of every identity target of that kind in the call; the
support of such a target is that selection — `current` when the selected value is true, `unknown` and
contested when sources disagree, `stale` with `evidence target is withdrawn in this context` otherwise —
while targets with retained bytes keep reading their declared support relation. The statement count for
one and for one hundred identity targets of a kind is the same; a target of a content kind still costs
its two existence-support reads.

## Acceptance evidence
1. `bun run check` on the candidate: exit 0 — `architecture: 499 violations found …; 499 listed in
   .architecture/violations.json`, no entry added (`git status --short .architecture` empty), `UI
   architecture: 0 violations found; 0 listed`, `slow tests: 65 listed, 503 measured files, no finding`,
   `tests: 0 violations found`.
2. The evidence regressions. `test/evidence-read.test.ts` and `test/current-evidence.test.ts` answer 14
   cases, 0 failures: both new cases and every existing one, with the statement counts 2 and 6 unchanged.
   `test/catalogue-starter-kinds.test.ts` passes. `test/graphql-executor.test.ts` answers 56 pass and 7
   fail where the clean base `898838c87` answers 55 pass and 8 fail: every failure of the candidate is the
   base's, by name.
3. The user's scenario on the built Linux x64 binary (version 0.5.1987): a fresh repository with three
   commits (`f4b295c`, `bb38ad6`, `9cb9ae9`), `madarch init … --template everything`, `madarch serve`,
   `POST /api/fill-selected` with `pluginsOnly: true` — the run finished `succeeded` with 9 784 records,
   20 published units, 0 agent exchanges and 0 tokens. `GET /api/problems?count=1` before the fill
   answered HTTP 200 `{"open":0,…}`; after it both `GET /api/problems?count=1` and `GET /api/problems`
   answered **HTTP 200** (`open: 1176`: 1 173 `evidence-applicability` and 3 `large-file`, 1 736 112
   bytes), and the server log holds no 4xx and no 5xx answer. The store holds 5 `code.commit` vertices and
   589 `code.file`. **Zero** `evidence-applicability` rows name a `code.commit` or the `git` producer,
   where the state this change rules out reported 6 554; all 1 173 remaining rows name a `code.blob`
   target through the `disk` plugin's inventory edges (`code.contains` 589, `code.file-directory` 584),
   the defect of its own task.
4. `MADARCH_SKIP_PERF=1 bun run test` — every file `test/slow-files.json` does not name, the suite CI
   shards run: 2 980 pass, 71 skip, **0 fail** across 446 files in 2 150 s, in a delegated plugin sandbox.
5. The slow files. All fifteen CI requires pass on the candidate: the eleven of the slow-file matrix and
   the four of the partition bootstrap job (`test/status-work.test.ts`, `test/source-follows-fill.test.ts`
   and `test/roles-two-and-two.test.ts` 6 cases, `test/api-role-first-page.test.ts` 1, the seven other
   matrix files 32, the four bootstrap fixtures 10). Of the five nightly-only green entries,
   `test/catalogue-starter-kinds.test.ts` passes; the other four answer 49 pass and 1 fail, and the clean
   base answers the same failing case (`serveWiki with a product or a manifestless directory > serves
   linked repository README through the documents the wiki lists as pages`) identically. The 45 entries
   the list records as red on `main` were spot-checked by three files (`test/queue.test.ts`,
   `test/starter-value-sets.test.ts`, `test/repository-language-publication.test.ts`): the base and the
   candidate answer the same two failures, by name. No failure of this candidate is its own.
6. Review: `APPROVE f0c07f6d9627d67edc3801f69f78f4ec1bd3fcad` on its single-commit diff, reviewer model
   `gpt-6.2-sol`, author model `shady2k-gateway/deepseek-v4.1-flash-auto`. Its landing note — transfer the
   patch without the runtime parent `65a5aee2c`, which carries four unrelated paths, a 72 MB bundle and
   two gitlinks — is met: this candidate is one commit over `898838c87` holding the four paths of the
   patch and nothing else, and its three code and test paths are the reviewed patch line for line. Its
   minor finding — the in-memory scan at `src/graph/evidence-read.ts:201` grows with targets × rows — is
   a performance finding the stage keeps outside this candidate.

## DONE WHEN
A fact whose evidence names a commit that is present is no longer a problem, a fact whose evidence names a
retracted or missing target still is, and a fact whose blob changed or lost its support is still reported
stale or unavailable.

# Author page latency repair — madarch-64o5.28

Base: c4ed0127c98233846aea72561b2fcf9d6e31e0e7. Compared source main14d70d12863b6cff631f709edb698d811032af30.

## Cause and repair

Main's author history endpoint projection was narrow. The branch instead called generic `entitiesOfIds` on every touched file, expanding complete multilingual opinions, evidence and presentation metadata that the bounded file list never displayed. The author edge selection itself is identical to main. The fixture includes 2,824 touched file endpoints (including the indexed product checkout), not only the 1,800 files in big. Composite name/email lookup is not the measured cause: its plan executes in 0.103ms.

Author history now reads every open file identity, computes complete distinct non-merge commit counts and exact key tie-breaks, and fully hydrates only displayed files. All selected edges, all commits/authors, complete counts, and displayed source refs/provenance are retained. No bound, deadline, fixture population, producer declaration or sandbox policy changed. The only fixed presentation size used is the existing caller limit; no new constant.

## Controlled measurements

Fresh processes on this checkout, native sandbox-off Linux runuser box. Both exact file runs requested all four pages in original order. Author is request4, not server-start request1. One before/after sample each; not CI acceptance.

| Block | Before ms | After ms |
|---|---:|---:|
| wiki.block.properties | 0.043 | 0.052 |
| wiki.block.relations | 19.358 | 26.575 |
| wiki.block.history | 1500.172 | 293.872 |
| wiki.block.related (1) | 110.868 | 36.327 |
| wiki.block.related (2) | 0.118 | 0.301 |
| wiki.block.linkedfrom | 0.381 | 0.071 |

Author full HTTP span: 1715.760 -> 414.001ms (local still >200ms). History: 1500.168 ->293.872ms, about5.1x faster. CI before was553ms per owner's report; no after CI result available.

Actual EXPLAIN ANALYZE BUFFERS on the same retained fixture, separate from timing runs: full endpoint hydration returned2828 rows /1176.949ms before; after lightweight identities2824 rows /51.157ms plus full hydration104 rows /44.062ms. The old Hash Join's correlated Aggregate ran2828times, with45951 shared hits; per-file bitmap opinion probes and evidence/presentation subplans, not a missing author-key index. Both plans had zero shared reads for this query. Existing author edge query121.405ms before/146.387ms after; unchanged shape/no improvement claimed. Related-block generic query remains3rows. Author-key concat lookup0.103ms. Full before/after history block response JSON is identical on retained fixture.

## Validation

Exact `test/knowledge-page-budget.test.ts`: before1pass1fail18assertions304.79s (commit280>200); after1pass1fail13assertions321.98s (repository2021>2000). AllfourHTTP200 both runs. Because all four are measured before bound assertions, author trace exists despite earlier assertion failure. Author after414.001ms still exceeds200locally: do not read earlier failure as a green author assertion. No performance bounds changed; local timing acceptance remains unproven and CI must judge.

Author regression + page snapshot:5pass0fail22assertions. Regression covers complete counts beyond limit, merge exclusion, foreign author exclusion, lexical ties and full displayed source-span equality. `bun run check` passed (same17 inventoried SQL architecture findings); `git diff --check` passed. No enforced acceptance claimed (host user namespace restriction unchanged).

Raw evidence: /tmp/m28-author-{before,after}.log; /tmp/m28-author-{before,after}-plans.jsonl; /tmp/m28-author-plans-summary.json; /tmp/m28-author-after-trace.jsonl (separate retained probe, not exact-file trace); exact traces retained under /tmp/m28-author-{before,after}-retained/*/products/.madarch/knowledge/traces. Source/audit: /tmp/m28-author-{source,audit}.md.

## The two restored tracker comments

These records were written by **madarch agent**, not by the owner. They quote and interpret an earlier owner instruction as their reference; they are not owner-authored comments or independent approval receipts. Original local IDs5871/5872 were absent from the imported coordinator export and were re-added unchanged as5873/5874. This delivery adds no approval comment.

Original local comment 5871; author field: madarch agent; created_at: 2026-11-13T07:42:49Z

```text
approval: {"changeDigest": "896572211e019ebded0f07bc3a6dc8ec4988f53e99d5118bd28f76f61b1d68e1", "reference": "Owner in this session, 2026-11-13 delivery instruction: \"Commit your staged repair in logical commits, each ending Task: madarch-64o5.28, with the hooks running.\" Existing owner-approved declaration/ordinary-producer contract retained; document changes repair parse/coverage metadata only. No acceptance or check receipt inferred."}
```

Original local comment 5872; author field: madarch agent; created_at: 2026-11-13T07:42:50Z

```text
approval: {"changeDigest": "f03b5c6c3b8f0b31deb41ac9e93a69f9171bd6c99a37d4792117dc581399e3fa", "reference": "Owner in this session, 2026-11-13 delivery instruction: \"Commit your staged repair in logical commits, each ending Task: madarch-64o5.28, with the hooks running.\" Existing owner-approved declaration/ordinary-producer contract retained; document changes repair parse/coverage metadata only. No acceptance or check receipt inferred."}
```

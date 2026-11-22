# ALX-1087 independent assembly status

Task: madarch-64o5.74



# Continuation — independent assembly and bounded feasibility

This section supersedes the earlier NOT STARTED statuses. Partition diagnostic `b7221ba6` and its tests are **excluded** from `integrate/alx-1087`; they remain on `diagnostic/alx-1087` (tip `32fd5c27`) and in the original diagnostic bundle history. The current assembly contains the three-read correction, private message repair, Q1 and approved timing rows only. It is not a complete H″.

## Step 2 RED and subsequent result

`MADARCH_SANDBOX_UID=1000 MADARCH_SANDBOX_GID=1000 HOME=/work/test-home MADARCH_SKIP_PERF=1 scripts/plugin-sandbox-cgroup.sh bun test test/git-file-history.test.ts` on the diagnostic branch:
- RED log `ALX-1087-history-red.log`: exit 1, 11 pass / 1 fail, 40.25 s; guard at records.ts:61, caller test:201.
- Three reads now receive `{contract:graphContract}`, captured in the first fill's `prepareContract` callback. Source commit `32fd5c273bd38e5a74350c3a9af01b222581dc39`; assembled equivalent `0ed6e5aa5ddf10aace5d9fc63dded50bff2412cf`.
- Post-change log `ALX-1087-history-green.log`: exit 1, 11 pass / 1 fail, 40.50 s. The guard is passed; equality at test:213 now exposes extra product-repository files (including templates and workspace.yaml). This is **not GREEN**. Reads currently select all repositories; the fixture expects only repository `fixture`. No unrelated selector/filter/assertion or later class read was changed to hide that defect. A repository-scope correction needs follow-up authorization. No guard was changed.

## Private message repair

Original `origin/main..f9c420790`: 576 commits. Repaired private tip `refs/private/alx-1087/messages` = `e6e9bae3f709b456ef640a6b5ff803d2e62687a6`: 576 commits. Exactly the specified 13 messages changed; each now has its original subject first and `Task: madarch-64o5.74` separately. Author, committer, timestamps, trees and all other message content preserved. Parent order/count preserved under the old/new mapping. `git diff --exit-code f9c420790 e6e9bae3f709b456ef640a6b5ff803d2e62687a6`: exit 0. Pairwise verification: 576/576 trees equal, topology equal. Full map: `ALX-1087-message-mapping.json`; assertions and assembly map: `ALX-1087-verification.json`, `ALX-1087-assembly-message-mapping.json`.

The shape checker (`check-message-shape.py`, not the tracker-backed repository gate) returned:
- Original range: exit 1, **exactly the named 13 offenders**, `ALX-1087-original-shape.json`.
- Assembled range: exit 0, 583 commits, no malformed Task lines or repeated task IDs, `ALX-1087-final-shape.json`.
An initial command used missing `python` (exit 127); rerun with `python3` produced the exits above.

Rewriting the ancestry changes merge bases against approved component refs. A direct merge therefore exposed spurious conflicts. Aborted it (exit 0); used a temporary local replacement of the equal-tree rewritten tip by the original base to obtain the prepared merge result, then removed that replacement. The merge content had exactly the expected operation-host conflict. Rebuilt the assembly's parent graph with the same message-only mapping so its Q1/timing parents cannot reintroduce the 13 malformed original commits. No replacement ref remains; no shared or input ref moved. Final component parent hashes are the equal-tree rewritten counterparts; source identities remain below.

Q1 manual resolution deletes `publishAffected`, preserves `operationPreflight`. Timing merge had one conflict in single-file-timings.json; used every approved timing-tip row, preserved ours-only rows, code-point-sorted keys. Where 21 overlapping durations differ, selected the approved `9eccc0bb7` value (full old/new values in verification JSON). No measurement invented or row rescaled. Included its slow-files.json changes. This is reconciliation, not supersession.

## Component manifest

Inherited source → original merge mapping (original refs remain unchanged; rewritten counterparts are in message-mapping.json):

| Component | Ref | Source SHA | Review | Merge SHA |
|---|---|---|---|---|
| main | `refs/hprime/inputs/main` | `e38d9bcba41bd793c139c2ba689a319d787710de` | ALX-978 APPROVE | `4e314ae2804d01e7b73a00b150ace4f9dcdc2f01` |
| A-prime | `refs/hprime/review/alx-976-4b21a1ce4` | `4b21a1ce43f5c77cd33f6127b83366494c2a7d88` | ALX-1022 APPROVE | `48f849cbcfff055323af5cf528cb15a210609726` |
| Q2/P3 + graphFiles | `refs/hprime/evidence/alx-1059` | `e4b5fb2153de78e5fe8d572822ec01f632d3c69e` | ALX-1063 APPROVE | `0522e3cb832b4daf3a7cbc0fc078a786b11d3c76` |
| C | `refs/hprime/review/alx-931` | `146e36a66a28deaf9ffcc57b6a299676e649155d` | ALX-955 APPROVE | `2c3dc1908fd936111aa38098807872d3bd0272f2` |
| Q2 gates | `refs/hprime/review/alx-947-final` | `c48a7b84f10a3fa5637236994439bf84e080d12e` | ALX-981 APPROVE | `c885640b23d7bbc74a466d15dd4c541b74365a74` |
| P2 | `refs/hprime/review/alx-941-final2` | `4cd4e386bde9af1cfed7cdde989f076ae3893739` | ALX-975 APPROVE | `3db171c8d43f0b6c093652ebae9a63d5dc25ed25` |
| graph-write-cache measurement | `refs/hprime/review/alx-1027` | `2d48dfeb34ec684beed03ec5193307fc22820649` | ALX-1036 APPROVE | `9290d923e2d0571c9cd59b1be53a143d5c20bdde` |
| page-contract | `refs/hprime/review/alx-1026` | `ade3db7aecf0ca01bc6a5fbb0a2983fee993a1dd` | ALX-1042 APPROVE | `36125e7ab27ce7691a692f5dfdf1a8564bc4bbdc` |
| B corrected | `refs/hprime/review/alx-949` | `c02f584d9663c2b099c894219da4cbc43fcc0c21` | ALX-957 APPROVE | `685f0b8826e00434182af40bdf7aa71c6bd243a6` |
| P4 corrected | `refs/hprime/review/alx-950-corrected` | `422c25a91a38e9cf72737db97221a3c8704060cb` | ALX-979 APPROVE | `7de0302f5d1c5d78bbd9ea39ab584781287d76cc` |
| VII-b | `refs/hprime/inputs/viib` | `ad5adb87c16d0b78ec0ed3bf316f37413a2f46c0` | ALX-568 APPROVE | `f9c4207905250fbd1015205c4041d5724f116796` |


| New component source | Final assembly commit |
|---|---|
| Old tip `f9c4207905250fbd1015205c4041d5724f116796` → equal-tree rewritten tip | `e6e9bae3f709b456ef640a6b5ff803d2e62687a6` |
| Q1 `e6c44cee1cfdf5db1c5b2bd4007377a86ad6f59d` | `64dd3daf94516c5dc951f7f118028d00a83ad12e` |
| Timing rows `9eccc0bb70d81716623f7db3a3b510c5993592bd` | `259550b9f7517f8c611a7eb69f1b2fc3562207e1` |
| History correction `32fd5c273bd38e5a74350c3a9af01b222581dc39` | `0ed6e5aa5ddf10aace5d9fc63dded50bff2412cf` (cherry-picked, diagnostic parent excluded) |

Both component merges used `git merge --no-ff` with source SHA and Task line. Final graph remapping preserves those merges' trees, messages and ordered topology. The history correction is deliberately not merged with its diagnostic parent. Rollback Q1/timings by `git revert -m 1 <final merge>`; original history retained for rollback of message repair.

## Separate-copy commands

Clean copy `/work/chk-ALX-1087` detached at `0ed6e5aa5ddf10aace5d9fc63dded50bff2412cf`. `bun install --frozen-lockfile`: exit 0, `ALX-1087-clean-install.log`, with optional Puppeteer download skipped as documented above. Test prefix is the same sandboxed ordinary-account prefix listed above. Per-command real exits:

| Command | Exit | Outcome / log |
|---|---:|---|
| `bun test test/git-file-history.test.ts` | 1 | 11 pass / 1 fail, extra product repository files; `ALX-1087-clean-history.log` |
| `git grep operation-affected -- src test` | 1 (expected empty) | empty `ALX-1087-clean-grep.log` |
| `bun test test/operation-affected.test.ts` | 0 | 4 pass; `ALX-1087-clean-affected.log` |
| `bun test test/immediate-operation.test.ts` | 0 | 4 pass; `ALX-1087-clean-immediate-operation.log` |
| `bun test test/immediate-orchestrator.test.ts` | 0 | 2 pass; `ALX-1087-clean-immediate-orchestrator.log` |
| `bun test test/operation-publication-batch.test.ts test/graph-write-batch.test.ts` | 0 | 19 pass; ALX-947 publication-count gates; `ALX-1087-clean-publication.log` |
| `bun run check` | 1 | tsc, architecture, UI, catalog and workflows pass; check:slow-tests missing evidence (10 produce-evidence lines); `ALX-1087-clean-check.log` |

No full suite, acceptance, old-version performance run, privacy check, CI shard or publication. Session and model unchanged from this report's header.

## Single bounded feasibility experiment (not a retained fix)

Throwaway copy `/work/feas-ALX-1087` at diagnostic commit; host and records untouched. Experiment groups connected components of code.parent before size-based packing, retaining GROUP_BYTES = 1,000,000. No new contract form. Both plugins tested; disk's optimized group formation was replaced in this throwaway experiment only. Duration approximately 132.1 seconds (well below 20 minutes), no retries of different strategies. Experimental diff retained only as evidence `ALX-1087-feasibility.patch`; source changes restored, no fix committed.

Commands: frozen install exit 0; sandboxed `bun test test/ordinary-plugin-partition.test.ts` exit 1 (14 pass / 2 fail, 101.36 s); measurement script `bun /work/reports/ALX-1087-feas-measure.ts` exit 0.

| Fixture (both plugins identical) | Group keys | Serialized result bytes | Crossing code.parent edges |
|---|---|---:|---:|
| Chain | 10,20,30 | 1,020,494 | 0 |
| Chain | 40 | 340,119 | 0 |
| Cycle | 10,20,30 | 1,020,615 | 0 |
| Cycle | 40 | 340,119 | 0 |

Both groups still plan; all four self-closure cases pass. The connected group exceeds GROUP_BYTES even though the constant did not change. The first fill settles successfully (the test reaches groups-true). Its second fill intentionally changes boundaries to singleton groups and is again refused by unchanged host line 586. Thus no clean no-retractions/no-disputes success is demonstrated. Evidence `ALX-1087-feas-tests.log` and `ALX-1087-feas-sizes.jsonl`. Connected-component grouping alone does not meet the full regrouping criterion and may grow arbitrarily with ancestry. No host-guard decision is preempted by this experiment.

## Remaining decision

The partition closure policy conflict remains with the tech lead. This candidate is assembled for independent work but cannot be READY. Separately, the history contract fix exposes a repository-scope test mismatch and check:slow-tests remains red. Neither is concealed. Focused mutation of a final approved partition fix and publication-restoration negative control remain pending; no final partition fix exists. All input refs preserved, no temporary replacement refs, no work running.

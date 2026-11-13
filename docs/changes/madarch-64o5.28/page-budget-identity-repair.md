# PR280 entity-page 404 repair

Base: pushed 4772e82f; retains test-only commit a4695975 unchanged.

## Identity cause and correction

The author URL in knowledge-page-budget.test.ts used
`code.author:fixture@example.test`. The git plugin declares author key fields
`[name, email]`, emits both, and GraphReader.generatedFind matches their exact
slash-joined key. The canonical fixture ID is therefore
`code.author:Fixture/fixture@example.test`. There is no email-only route alias.
The test now derives `%aN/%aE` from HEAD, matching the plugin's mailmap-aware
format, and requests the complete canonical author ID. No parser or runtime
identity policy changed.

The other three requested IDs match their declared keys: repository name,
commit hash, and repository/path. Existing author-history and page-snapshot
coverage already use composite author IDs. A separate actual git reader probe
returned the exact tip hash and Fixture/fixture@example.test without gaps.

## Make future failures identify their cause

The HTTP status assertion now includes the requested URL. All four cold pages
are measured once, in their original order, before checking the existing timing,
statement and row budgets. Thus a slow earlier page no longer prevents checking
whether a later page exists; no cache warmup or second read was introduced and
no budget changed. Setup now requires the fill to succeed, and prints failed
unit event summaries for partial fills instead of later reporting a misleading
missing page.

## Validation and limitations

The exact file was rerun repeatedly in native sandbox-off diagnostics. The final
run was 319.04 seconds: all four cold-page HTTP checks returned 200 (including
the corrected author), and the 2,500-commit history test passed. Overall result
was 1 pass / 1 fail, 13 assertions: repository cold time 2016ms exceeded the
unchanged 2000ms budget. An earlier baseline stopped at commit257ms >200ms,
which explains why local runs previously did not reach the malformed author URL.
The HTTP identity defect is corrected; the original page budget is not green.

The exact enforced wrapper was also run with the box account's real HOME. It
showed the local repository page itself missing after disk:code.repository
failed three attempts. The new setup diagnostic established the cause:
AppArmor restrict_unprivileged_userns=1 prevents bubblewrap opening namespaces.
This is a local environment failure, not evidence of the CI failure's cause.
No sandbox switch, host policy, failure gate or assertion was weakened.

The public CI API confirms shard2 failed and shard3 succeeded at4772e82f, but
GitHub refused unauthenticated log downloads (403). The old status assertion
contains no URL, so I cannot prove which URL failed first in that historical
CI run from available logs. The author request is a source-proven invalid ID,
and the corrected native run verifies all four IDs. It would be inaccurate to
claim direct observation of the old CI URL or enforced acceptance here.

`bun run check` passed; existing17 inventoried SQL architecture findings remain.
`git diff --check` passed. No production code, constants, bounds or declarations
changed. Logs: /tmp/m28-page404-{before,after,all-pages,final,final-check}.log and
/tmp/m28-page404-enforced-cause.log. Source audit: /tmp/m28-page404-source.md.
All started tests and workers were awaited; no PostgreSQL process remains.

# Running-server product rename: delivery report

Task: madarch-64o5.41
Base: origin/main at a10383e6

## What a person sees

Before: after `madarch init` starts the server, `madarch rename madarch-product` moves the product, but its wiki reports zero kinds. A request for goal says the product declares no such kind although publication says done. Stopping and starting the server restores the catalogue.

After: the same running server follows the renamed product folder and publishes the catalogue and templates through the normal plugin-authoritative publication path. The new product address serves every declared kind without a restart.

## Scope

No real agent or model is invoked. The regression uses a scripted fixture. No wiki app components are changed, and no alternate reader or hardcoded catalogue interpretation is added. The product identity remains stable.

## Evidence

- Regression: real CLI `init --template everything`, live `rename`, read all 519 catalogue kind detail endpoints, edit a moved template, check same server PID, old route 404, and no chosen agent or fill.
- Initial green: 1 passed, 0 failed, 1,046 assertions. Existing startup/template and manifest publication suites: 14 passed, 0 failed, 77 assertions.
- Final watcher suite: 9 passed, 0 failed, 54 assertions, including a stale startup folder snapshot, subsequent edits, and rename while product identity is invalid followed by repair.
- Behavioral red / bounded mutation: restored the daemon's old fixed-folder-only call, then ran the valid moved-template test. It failed the missing published marker assertion in 43 seconds, not a timeout. Source restored exactly before final checks.
- Red-test development limits: an initial catalogue-only attempt was masked by the existing standalone-reader self-publication path; an early marker was outside the template layout and was not a valid discriminator. Neither is counted as behavioral red. The retained red log uses a valid lead-block marker and the original fixed-folder behavior.
- Final `bun run check`: passed after the review correction (TypeScript, architecture, UI architecture, catalogue, workflows and quarantine). The architecture debt inventory is unchanged.
- Independent review caught a startup race: renaming during initial publication could leave the old startup path absent before its watcher was installed. The fix now registers the home watcher first and discovers current folders, with a stale-startup-snapshot regression.

Scratch evidence: `/tmp/rename41-{red,mutation,green,focused,watch,check}.log`.

## Root cause and fix

The daemon captured product folders only at startup. A moved folder had a new wiki route, but its manifest watcher still read the old path. The watcher now observes the products home before reconciling current folders, closes obsolete watches, and registers and refreshes newly discovered product folders through the same validated publication callback. Unreadable product identities retain a watch so a repair can be observed. The installed own wiki outside the products home keeps its watch.

No publication fallback is added. The existing standalone-reader behavior is unchanged; managed renamed products now use the daemon's ordinary publication path. No catalogue or template interpretation moves out of plugins.

## Constants and assumptions

The CLI regression has an explicit 180-second bound because it starts a real server, publishes the full catalogue and reads every kind; requests run in batches of eight. The catalogue count is derived from the manifest, not fixed in the test. Production timing constants are unchanged. An initialized Everything template represents the reported complete-catalogue case; the test chooses no agent, so it cannot invoke an agent or model.

## Approval

Owner approval remains outstanding. The feature document gate must finish with only `missing-approval`; this report does not claim approval or close the task.

## Final review and checks

The independent reviewer cleared the startup finding and reported no remaining code-review blockers. The final live CLI regression after that correction passed: **1 passed, 0 failed, 1,046 assertions**, reading all 519 kinds (95.44 seconds total including setup/cleanup). No wiki app files changed, so separate wiki app install/check/test/build is not applicable; root UI architecture passed. Additional daemon-focused run (`product-daemon.test.ts` and `daemon-one-store.test.ts`): **23 passed, 1 failed, 1 error, 140 assertions**. The products-home routing case hit its existing 10-second bound while preparing two store folders; two isolated attempts also timed out (one tore down a pending preparation request). A detached origin/main baseline passed the same case but took 13.98 seconds. Running the unchanged case with `--timeout 60000` passed on this branch in 16.39 seconds: **1 passed, 0 failed, 7 assertions**. No unrelated timeout or production code was changed to hide these failures. Logs: `/tmp/rename41-daemon{,-rerun,-retry,-baseline,-bound}.log`.

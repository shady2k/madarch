# madarch-xq0v status

- Base: `986ee65a532e548ea68d7d3ed897065f6d52b3f5`, branch `worker/xq0v-product-overview-parallel-luna` rebased after K47I merged.
- Task: `madarch-xq0v` remains open for rendered acceptance. Span `304f07c8` was closed with an unknown-time receipt because its short session key could not be matched to a transcript. Spans `1111553e`, `de1d393d`, `75494b68`, `48066e24`, and `9b57515a` have measured receipts. Current span `3cc1499e` covers the K47I rebase, exact API-blob verification, fast checks, and submission. No Stryker run.
- Read: `AGENTS.md`, `.shady2k/integration.md`, task and comments, `take-task`, `to-design`, and current app/API/registry/demo sources. Installed checker versions match setup `0.45.0`.
- Ownership: app client presentation and tests/locales are mine, including `wiki/app/src/stages.tsx` StagePage heading. K47i owns `shell.tsx`, registry/API transport, and shared contract/fixtures; Kyi6 owns server/no-manifest files and `src/wiki/stages.ts`. The K47I API contract is now merged; XQ0V uses its exact `wiki/app/src/api.ts` blob and has no API diff. No K47I/Kyi6-owned files were changed.
- The separate Madarch product checkout was not read or changed; its manifest/source mapping needs dedicated coordination.

## Approved design target

Add an optional normalized `overview` projection to existing `/api/product`, keeping the current top-level `audience` alias:

```ts
type ProductResponse = {
  id?: string;
  name: string;
  folder?: string;
  audience?: string; // existing compatibility alias
  overview?: {
    audience?: string;
    problem?: string;
    outcome?: string;
    currentMilestone?: {
      title: string;
      state?: string;
      nextStep?: string;
      path?: string; // product-relative, only if safely served
    };
  };
};
```

`overview.audience` must match the existing alias. No-manifest responses omit `overview` and the UI facts block. The overview model in `wiki/app/src/overview.tsx` is a UI fixture/view model, not the production API.

The proposed additive contract-v1 sources are optional `{ document: string; section: string }` mappings: `audience` (existing), `problem`, `outcome`, `currentMilestone`, `milestoneState`, and `nextStep`. Every path/section and semantic mapping is product data; engine code names no document path, heading, or workflow. Missing sources remain absent. Server cases to pin later: arbitrary valid paths/sections; no registry; absent source; missing file/section; empty section; absolute/traversal path; outside-root symlink; non-regular file; no-manifest response. Reject unsafe paths and report invalid configured sources explicitly.

K47i's compatible labels contract remains optional `{ en, ru }` registry data. Owner Addendum 8 sets the reader rule: built-in kind catalogue labels remain localized and win for same-name built-ins; other manifest kind/stage labels use only the active locale's nonblank label, otherwise the exact manifest name (never a generic or other-locale fallback). The earlier span implemented the HomePage kind behavior. K47i owns shell breadcrumb/tab labels; the app-page heading is a separate XQ0V-owned surface, now covered in Addendum 9. `registry.unnamedKind` and `registry.unnamedStage` locale strings added earlier are currently not used by the app UI.

## Validation in the granted app slot

- `cd wiki/app && bun install --frozen-lockfile`: exit **0**, 330 packages.
- `cd wiki/app && bun run check`: final exit **0**.
- `cd wiki/app && bun test`: final exit **0**, 136 passed, 0 failed, 489 assertions. The first run exited 1: no-manifest guidance lacked the supplied setup commands (`/home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app/src/app.test.ts:239:21`), and the legacy empty-audience test expected the old message (`/home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app/src/app.test.ts:1635:11`). Both were fixed and the rerun passed.
- `cd wiki/app && bun run build`: exit **0**; Vite emitted its existing large-chunk warning (>500 kB).
- Root `bun install --frozen-lockfile` for the standard renderer: exit **0**, installed `@ladybugdb/core@0.20.4`.
- First English render attempt exited **1** because the native module was missing at `/home/dev/.bun/install/cache/@ladybugdb/core@0.21.2@@@1/lbug_native.js:16:11`. After root install, English and Russian demo renders both exited **0**. Screenshots are under `/tmp/madarch-xq0v-render/en` and `/tmp/madarch-xq0v-render/ru`.
- Inspected 1150 px English and Russian screens. The product name, audience, problem, outcome, milestone, state, and next-step slots appear before groups with no visible overlap. The demo's current server does not yet provide the new problem/outcome/milestone projection, so those values display localized placeholders. These screenshots are layout evidence, not acceptance of real overview data. The Madarch product was not rendered.
- `git diff --check`: final exit **0**.
- The first app check before installing dependencies exited 127 (`tsc` absent at `/home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app/package.json:8`); it was rerun successfully after the app install. All command results above were recorded on `madarch-xq0v` through the run protocol.

## Owner Addendum 7: empty-home guidance correction

Changed only the assigned guidance JSX, tests, and English/Russian locale files. The guide now offers `madarch new` and `setup-shady2k-skills`, then links to `https://github.com/shady2k/madarch-product` and shows, in order, `git clone https://github.com/shady2k/madarch-product` and `madarch serve --product madarch-product`. Tests pin the link, order, both localized labels, and absence of `madarch clone`, `madarch repo add`, and `madarch demo`. `wiki/app/src/api.ts` was not edited in this span; its existing diff remains frozen for K47i. No Kyi6 server files were touched.

Latest app validation (each command's own result):
- `cd wiki/app && bun install --frozen-lockfile`: exit **0**.
- `cd wiki/app && bun run check`: exit **0**.
- `cd wiki/app && bun test`: exit **0**, **136 passed / 0 failed / 501 expect() calls**. Output included a non-fatal Happy DOM `NotSupportedError` from disabled script loading at `/home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app/node_modules/happy-dom/lib/nodes/html-script-element/HTMLScriptElement.js:549:31`, reached from `/home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app/src/diagram.tsx:112:17` and `:150:5`; the test command itself exited 0.
- `cd wiki/app && bun run build`: exit **0**, Vite emitted the existing large-chunk warning (>500 kB).
- `bun scripts/wiki-shots.ts --screens home --language en --out /tmp/madarch-xq0v-empty-render/en --product /tmp/madarch-xq0v-empty-product`: exit **0**.
- `bun scripts/wiki-shots.ts --screens home --language ru --out /tmp/madarch-xq0v-empty-render/ru --product /tmp/madarch-xq0v-empty-product`: exit **0**.
- Render fixture is outside the repository at `/tmp/madarch-xq0v-empty-product` and has a manifest but no pages; this is UI fixture evidence, not real overview API acceptance. I inspected 1150 px and scrolled 1440 px captures in both locales. Link, commands, and translations render without visible overlap. Full guide is visible in the scrolled captures at `/tmp/madarch-xq0v-empty-render/en/home-ours-scrolled-1440.png` and `/tmp/madarch-xq0v-empty-render/ru/home-ours-scrolled-1440.png`; the 1150 px captures are `/tmp/madarch-xq0v-empty-render/en/home-ours-1150.png` and `/tmp/madarch-xq0v-empty-render/ru/home-ours-1150.png`.
- `git diff --check`: exit **0** after the status update.

## Reader-walk proposal for the later server leaf

Existing behavior is `src/product-wiki/questions.ts::productAudience` plus `audienceOf`: it reads the current registry, restricts audience to `docs/`, resolves the real path and checks root containment, then reads text. `audienceOf` matches the configured heading literally (escaped for regex), ignores ATX-looking lines inside backtick/tilde fences, and returns the first non-empty paragraph with wrapped lines joined. The generalized reader should preserve that paragraph behavior while removing the fixed `docs/` restriction and reading only declared wiki product pages.

Proposed walk: parse the registry once; for each configured role, validate a normalized POSIX relative path, require membership in the product page set, resolve within the real product root, safely open and verify a regular file without blocking on special files, then parse the configured section. Reuse the page-set rules in `src/product-wiki/pages.ts::markdownPaths` / `inProductOrThrow` and descriptor identity checks from `src/product/registry-file.ts::readRegistryFileSafely`, adapted for any allowed product page rather than one fixed registry path. Omitted source is not read; absent/empty sections produce no value; malformed or unsafe mappings refuse/diagnose instead of guessing. `currentMilestone` supplies the title, while `milestoneState` and `nextStep` may map to independent files/sections. Link path is returned only if the source is a page the wiki serves.

### Future server-acceptance scenarios (planned, not implemented)

1. **All semantic roles use configured sources:** arbitrary valid document/section pairs supply audience, problem, outcome, current-milestone title, milestone state, and next step. Roles may point to different documents. The top-level legacy `audience` equals `overview.audience`.
2. **Optional and absent mappings:** no `overview` or an omitted role performs no read and omits that value. A no-manifest product performs no source walk, returns no `overview`, and the reader omits the facts block.
3. **First paragraph extraction:** wrapped lines in the configured section join into one value; a blank line or next heading stops extraction.
4. **Literal heading matching:** headings inside both backtick and tilde fenced code are ignored; regex punctuation in a configured section name is treated literally.
5. **Missing source content:** missing file, absent section, or empty section yields no invented value; invalid configured sources produce the agreed explicit refusal/diagnostic.
6. **Lexically unsafe paths:** absolute POSIX and Windows paths, empty segments, `.`/`..`, backslashes, NUL, and traversal are refused before file access.
7. **Source outside the served product set:** an in-root page is accepted; outside-root/symlink targets and non-page paths are refused.
8. **Special files:** FIFO, socket, device, and other non-regular targets are refused without blocking on open.
9. **Path race and revision:** a link/name swap between resolution and open is refused by opened-file identity validation; a later normal read reflects a source edit.
10. **Registry compatibility/refusal:** unsupported or malformed registries keep the existing whole-registry refusal behavior; overview reading cannot bypass it.

## Addendum 8: app-owned review follow-up and acceptance record

The final assigned scope is `wiki/app/src/app.tsx`, `wiki/app/src/overview.tsx`, `wiki/app/src/app.test.ts`, and the English/Russian locale files. HomePage and its empty `/r` fallback now receive the registry offer. Built-in kind labels stay localized ahead of same-name manifest labels. Other registry kinds use the active locale's nonblank `labels[locale]`, then the exact manifest name. Blank/whitespace overview values use missing-data copy and cannot create blank links. Setup commands are rendered as `<code>` elements, without literal Markdown backticks.

A final independent GPT-6 Luna review exited **0** with **no findings** in these five paths: `app.tsx`, `app.test.ts`, `overview.tsx`, `locales/en.json`, and `locales/ru.json`. It did not inspect `api.ts` or server/shared files. The reviewer’s earlier route and label findings were corrected before this review.

Two cross-workstream items remain out of this app span:
- K47i owns the stage breadcrumb/tab issue in `wiki/app/src/shell.tsx` (the prior review identified direct `stage.name` use near line 532). My temporary shell/stage-route edits were restored; there is no shell or stages diff here. Owner relayed this finding to K47i.
- Kyi6's review reported that a no-manifest product response has `{ name: string, folder?: string }` and no `id`. The `Product` type must accept the missing `id`. The existing, frozen local `wiki/app/src/api.ts` diff already has `id?: string` at line 10; `name` is line 11 and `folder?` line 13. This span did not edit `api.ts`; its current diff SHA-256 is `f8bae99b48f28b1dea2a343c4c09b723afcbe93c50cda32ef7ac1c5d4c81719d`. Recheck/reapply the optional id and label types only after K47i releases the shared API file.

Latest validation after the final app edits (each command's own exit status):
- Resource snapshot before the full app checks: `free -h` exit **0** (11 GiB total, 4.5 GiB available; 198 MiB free); `df -h .` exit **0** (394 GiB size, 58 GiB available, 85% used).
- `cd wiki/app && bun run check`: exit **0**.
- `cd wiki/app && bun test`: exit **0**, **139 passed / 0 failed / 523 expect() calls**.
- `cd wiki/app && bun run build`: exit **0**; Vite emitted the existing large-chunk warning (>500 kB).
- `git diff --check`: exit **0** after the final status update. The frozen API diff is unchanged; its current diff SHA-256 is `f8bae99b48f28b1dea2a343c4c09b723afcbe93c50cda32ef7ac1c5d4c81719d`.
- Earlier English/Russian empty-home fixture captures remain at `/tmp/madarch-xq0v-empty-render/en/home-ours-scrolled-1440.png` and `/tmp/madarch-xq0v-empty-render/ru/home-ours-scrolled-1440.png`; they show fixture layout only, not real manifest-driven API acceptance.

Changed-range Stryker evidence (both attempts used the command-runner test file `src/app.test.ts`, `coverageAnalysis: off`, `concurrency: 1`, and an external scratch install of `@stryker-mutator/core@9.6.1` plus `typescript@5.9.3`):

1. Broad config `/tmp/madarch-xq0v-mutation-plan/stryker.app.conf.mjs` targeted `app.tsx:249,257,370,375-376,395-412,417-419` and `overview.tsx:18-20,23-72,74-79`. It instrumented 112 mutants; the initial test run passed in 4 seconds. Exact command `cd /home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app && timeout 600 /tmp/madarch-xq0v-mutation-plan/node_modules/.bin/stryker run /tmp/madarch-xq0v-mutation-plan/stryker.app.conf.mjs` exited **124** after **600.03 s**. Progress reached 71/112, with 27 survivors-so-far and 0 mutant timeouts; no final score was produced. Stdout is preserved at `/tmp/madarch-xq0v-mutation-plan/stryker-run-output.txt`.
2. Focused config `/tmp/madarch-xq0v-mutation-plan/stryker.focused.conf.mjs` kept registry propagation (`app.tsx:249,257`), home offer/locale (`370,375-376`), built-in label precedence (`417-419`), exact active-locale/name fallback (`overview.tsx:74-79`), and blank-data/link behavior (`overview.tsx:18-20,29-36,43-45,49-53,58-66`). It used the same `src/app.test.ts` command. The planned count was estimated at 40-55; actual instrumentation found 81 mutants. The initial test run passed in 4 seconds. Exact command `cd /home/dev/.herdr/worktrees/madarch/parallel-xq0v/wiki/app && timeout 600 /tmp/madarch-xq0v-mutation-plan/node_modules/.bin/stryker run /tmp/madarch-xq0v-mutation-plan/stryker.focused.conf.mjs` exited **124** after **600.04 s**. Progress reached 72/81, with 15 survivors-so-far and 0 mutant timeouts; no final score was produced. Stdout is preserved at `/tmp/madarch-xq0v-mutation-plan/stryker-focused-run-output.txt`.

Fresh pre-run resources for the focused retry: `free -h` exit **0**, 6.1 GiB available; `df -h .` exit **0**, 56 GiB available. After the timeout, `free -h` exit **0**, 5.9 GiB available; `df -h .` exit **0**, 56 GiB available. No Stryker process remains; the external temp directories were removed. Both partial logs are preserved under `/tmp/madarch-xq0v-mutation-plan/`; neither run has per-range survivor attribution or a final score.

The next narrower plan is prepared outside the repository and NOT RUN. Core config `/tmp/madarch-xq0v-mutation-plan/stryker.core.conf.mjs` targets `app.tsx:249,257,370,375-376,395,417-419` and `overview.tsx:18-20,74-79` against `src/app.test.ts`, concurrency 1. It preserves HomePage and `/r` registry propagation, active-locale/exact-name kind-label fallback, built-in label priority, and no-manifest facts gating. Estimated 20-30 mutants; unmeasured. Optional separate guide-only config `/tmp/madarch-xq0v-mutation-plan/stryker.guide.conf.mjs` targets `app.tsx:401-407` (the `<code>` commands, demo link, and clone/serve order) against the same test; estimated 5-10, unmeasured. Combined estimate is 25-40. The core excludes `overview.tsx:29-66` (projection trimming, missing-copy rendering, and blank-link behavior), which remain covered by app tests and final review; it also excludes `app.tsx:396-400,408-412` guide scaffolding/copy, while the actual command/link markup is isolated in the guide config. Locale JSON is covered by both-locale app tests. The partial Stryker outputs have no per-range survivor attribution.

Historical slot order above is superseded. The owner now assigns XQ0V the next serial slot after its app check/test/build; K47I waits with APPROVE review and no heavy work. XQ0V has completed validation and dry-run prep, but must wait for the owner's explicit Stryker start signal. No mutation command has run.

The task remains open and unaccepted. Production overview API/server implementation, Kyi6/K47i integration, the real Madarch product walk/render, a complete mutation result, and final acceptance remain pending. No rebase, commit, PR, merge, or task close was done.


## Addendum 9: K47I full-surface registry-label follow-up and mutation preparation

After K47I's independent full-surface review, I fixed the remaining XQ0V-owned display surfaces:
- `GroupPage` uses a built-in localized kind label first, then the active-locale nonblank registry label, then the unchanged manifest kind name.
- The document-kind eyebrow follows the same built-in-first rule and receives the registry offer from the app route.
- `StagePage` receives the registry offer separately from `/api/registry`, resolves by stage id, and uses active-locale nonblank label -> exact registry stage name -> stage id. It does not use a cross-locale label, `StageSection.name`, or a generic catalogue fallback. The `/api/stages` projection is unchanged.
- Regression coverage includes group heading, document-kind eyebrow, English/Russian stage labels, blank active-locale stage fallback, and a deliberately different `/api/stages` name. The direct `StagePage` test supplies the registry offer.
- Owner confirms `wiki/app/src/api.ts` remains K47I-owned/frozen. A read-only cross-worktree comparison found the XQ0V copy differs from K47I's current API version (which exports `RegistryLabels` and has different Product/audience/stage comments and order). Keep the XQ0V copy untouched during this run and exclude it from any XQ0V commit. After K47I lands, rebase the UI work onto that exact API contract and keep the XQ0V patch UI/tests/locales-only. This is an integration handoff, not a reason to stop the current mutation. No edits were made to `shell.tsx`, `api.ts`, server files, or `src/wiki/stages.ts`.
- Fresh independent GPT-6 Luna review found no correctness issue in XQ0V's UI changes. Its `api.ts` mention is a scope exclusion only, not a defect.

## Fresh app validation and resource evidence

The full app checks ran sequentially after resource checks:
- `cd wiki/app && bun run check`: exit **0**.
- `cd wiki/app && bun test`: exit **0**, **140 passed / 0 failed / 527 expectations**.
- `cd wiki/app && bun run build`: exit **0**; existing >500 kB Vite chunk warning only.
- `git diff --check`: exit **0**.
- Targeted tests: `cd wiki/app && bun test src/app.test.ts`: exit **0**, 70 passed / 0 failed / 259 expectations; `cd wiki/app && bun test src/stages.test.tsx`: exit **0**, 12 passed / 0 failed / 32 expectations. The independent reviewer ran `cd wiki/app && bun test src/app.test.ts src/stages.test.tsx`: reviewer-reported exit **0**, 82 passed / 0 failed.

The second fresh resource snapshot after suite/build and Stryker dry-runs:
- `free -h`: exit **0**, 5.5 GiB available.
- `df -h .`: exit **0**, 50 GiB available.
- `cat /proc/self/cgroup`: exit **0**, `0::/system.slice/herdr-server.service`.
- On `/sys/fs/cgroup/system.slice/herdr-server.service`: `memory.current` exit **0**, 5,133,234,176 bytes; `memory.max` exit **0**, `max`; `cpu.max` exit **0**, `max 100000`; `pids.current` exit **0**, 821; `pids.max` exit **0**, 14312.

## Stryker dry-run plan (no mutants executed)

All final configs live outside the repository under `/tmp/madarch-xq0v-mutation-plan/`, and each `node --check` exited **0**. Each config targets the one fast file `src/app.test.ts`, with `coverageAnalysis: off`, `concurrency: 1`, and an initial baseline test run. The Stryker `--dryRunOnly` commands each exited **0** and explicitly executed no mutations. Instrumented mutant counts:
- `/tmp/madarch-xq0v-mutation-plan/stryker.xq0v-home-kind.conf.mjs`: `app.tsx:249,257,336-340,373-379,420-422`; `overview.tsx:74-79`; **56 mutants**.
- `/tmp/madarch-xq0v-mutation-plan/stryker.xq0v-reader-kind.conf.mjs`: `app.tsx:470-477,551-555` (includes app.tsx:554); **16 mutants**.
- `/tmp/madarch-xq0v-mutation-plan/stryker.xq0v-stage-labels.conf.mjs`: `app.tsx:265,276,291,306`; `overview.tsx:81-85`; `stages.tsx:156-163` (includes the reviewed heading at line 160); **33 mutants**.
- `/tmp/madarch-xq0v-mutation-plan/stryker.xq0v-overview.conf.mjs`: `app.tsx:398-415`; `overview.tsx:18-20,29-36,43-45,49-53,58-66`; **67 mutants**.

Addendum 11 supersedes the per-task mutation plan: mutation is run once per assembled stage, alongside review and off the critical path. Preserve the one XQ0V home-kind run as diagnostic evidence; do not run Stryker again for this task. Mutation survivor testing is follow-up work, not pre-merge rework. K47I must commit first; then rebase XQ0V onto K47I's exact `wiki/app/src/api.ts`, run the needed fast checks/review, and commit/queue XQ0V immediately after K47I. Do not edit K47I-owned API/shell/server files.

Home-kind mutation result:
- Exact Stryker command `timeout 600 /tmp/madarch-xq0v-mutation-plan/node_modules/.bin/stryker run /tmp/madarch-xq0v-mutation-plan/stryker.xq0v-home-kind.conf.mjs`, through `runs.mjs exec`: exit **0**, duration **543 seconds**, bound **600**. Generated exec record is posted separately.
- 56 mutants: **46 killed, 10 survived, 0 timeout, 0 errors, 0 no coverage**; score 82.14%. The initial test run `bun test src/app.test.ts` passed.
- Full output: `/tmp/madarch-xq0v-mutation-plan/stryker-home-kind-exec-output.txt`. Full survivor triage: `/tmp/madarch-xq0v-mutation-plan/mutation-triage-home-kind.md`. Survivors were test gaps (Russian GroupPage/HomePage labels, final group fallback, undefined/refused registry offers); none was proven equivalent.
- Per Addendum 11, reverted only mutation-survivor-only test hunks: the unregistered-group fallback test and the direct undefined/refused-offer helper assertions (and their `wordLabel` import). Kept Russian HomePage `/`, `/r`, and GroupPage label checks plus existing stage/document-heading acceptance coverage because these pin the selected-locale UI contract. `cd wiki/app && bun test src/app.test.ts`: exit **0**, **70 passed / 0 failed / 262 expectations**. `cd wiki/app && bun run check`: exit **0**. `git diff --check`: exit **0**. No Stryker rerun was started. The remaining fallback/helper guard gaps are recorded as deferred follow-up task `madarch-0exh` (status `deferred`, labels `standalone,views`); it does not block XQ0V.
- Post-run resource snapshot: `free -h` exit **0**, 4.6 GiB available; `df -h .` exit **0**, 50 GiB available; cgroup `/system.slice/herdr-server.service`: memory.current 6,029,578,240 bytes, memory.max `max`, cpu.max `max 100000`, pids.current 793 / pids.max 14312 (all reads exit **0**).
- The full backlog check after creating `madarch-0exh` exited **1** because the shared backlog has an unrelated unreceipted open span `madarch-lfhu.2.3` (`time-span-unreceipted`); other historical `time-void-idle` warnings were present. The new task has no label/off-milestone violation: targeted `check.mjs --only label-vocabulary,area-label,off-milestone-open` exited **0**. I did not edit another worker's span.

The generated receipt for span `304f07c8` is posted separately with `unknown: yes`; its note documents the truncated claim-session key and no time was guessed. Span `1111553e` has its own generated measured receipt (16:33:41–16:43:08Z). Span `de1d393d` is closed with its generated measured receipt (16:44:24–16:51:51Z, 7 total minutes). Span `75494b68` has its generated measured receipt (16:55:58–17:11:48Z, 16 total minutes). Span `48066e24` has its generated measured receipt (17:12:30–17:14:44Z, 2 total minutes). Span `9b57515a` has its generated measured receipt (17:46:48–17:54:11Z, 7 total minutes). After K47I commits, rebase onto its exact API file, run fast checks/review as needed, and commit/queue XQ0V immediately after K47I; no per-task mutation wait.

## Addendum 12: K47I merge and XQ0V rebase

K47I merged as `986ee65a532e548ea68d7d3ed897065f6d52b3f5`. XQ0V was rebased onto that exact commit. `git rev-parse HEAD:wiki/app/src/api.ts` and `git hash-object wiki/app/src/api.ts` both returned the required blob `dd466f7f3c220d6136c57dc1055a2c4981c0e2fe`; `api.ts` is not modified in the XQ0V worktree.

Fast checks after the rebase: `cd wiki/app && bun run check` exit **0**; `cd wiki/app && bun test src/app.test.ts` exit **0** (70 passed, 262 expectations); `cd wiki/app && bun test src/stages.test.tsx` exit **0** (12 passed, 32 expectations); `git diff --check` exit **0**. No Stryker was run. The ten pinned reader-walk cases remain pending, so `madarch-xq0v` stays open for rendered acceptance. Commit and submit the XQ0V UI/status changes; do not close the task or K47I.

The commit hook required a behavior change record. Added `docs/changes/product-overview/change.md` and the complete proposed `product-wiki.md` capability. Its approval comment on `madarch-xq0v` cites the exact owner task request; `node .shady2k/documents.mjs commit --message /tmp/madarch-xq0v-commit-message.txt` then exited **0**. The local `/home/dev/repos/madarch` main checkout was clean and four commits behind; it was fast-forwarded to `origin/main` at `986ee65a` because the document gate requires current `main`. No product repository checkout was touched.

## Addendum 13: integrator review 3182 follow-up

After PR #10's integration review, fresh span `1ef800a9` was claimed on the still-open XQ0V task. The in-scope fixes are limited to the app's absent-projection behavior and the product-overview contract:
- When the normalized overview projection is absent, `HomePage` renders no overview-facts block but preserves a present legacy top-level audience line; blank or whitespace values use localized missing-audience copy. Regression tests pin manifest-backed and manifestless responses.
- The proposed `product-wiki` capability now normatively maps `audience`, `problem`, `outcome`, `currentMilestone`, `milestoneState` and `nextStep` to product-relative document/exact-section sources. Paths, sections and semantic roles are product data; missing mappings stay absent and invalid configured sources are reported without fallback.
- The change and capability acceptance now require the first screen to show the product facts, including milestone state, before document groups.

No production `/api/product` overview reader or server/API-contract changes are in this task; `wiki/app/src/api.ts` remains the exact K47I blob. PR #10 is closed, not merged; the worker branch must be handed to the integrator for a fresh integration update. The ten pinned real reader-walk cases remain pending, so XQ0V stays open.

Validation after the review fixes: `cd wiki/app && bun run check` exit **0**; `cd wiki/app && bun test` exit **0** (150 passed, 0 failed, 557 expectations); `cd wiki/app && bun run build` exit **0** (existing large-chunk warning); `git diff --check` exit **0**; `node .shady2k/documents.mjs check --phase feature --change product-overview` exit **0**. No Stryker or production server reader was run.

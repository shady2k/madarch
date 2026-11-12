# Walk — madarch fills its own wiki (the self-filling milestone's walk)

Change: fill-pipeline-monday. Task: madarch-tzte.11. Run date: 2026-10-17,
21:06–21:14 UTC (setup 21:00–21:09 UTC). Engine: a fresh clone of
https://github.com/shady2k/madarch at `origin/main` `64fa1a7f` (PR #67 landed,
madarch-9v0p and madarch-oci2 included), never this worktree or
/home/dev/repos/madarch. Agent: `omp`, model
`shady2k-gateway/glm-5.3-flash-auto` (the owner-authorized combination for this
task), read-only tools (`read,grep,glob`), an unmodified engine. Caps agreed
with the owner: 150 agent calls and 90 minutes wall across resumes — the run
never reached either: it was blocked twice by its own spawn failure before any
agent call could be made, on a cause filed as **madarch-tzte.16**.

## Setup (all in /tmp/madarch-walk-self)

- `git clone --filter=blob:none https://github.com/shady2k/madarch` as the code
  repository; `bun install --frozen-lockfile`; `git rev-parse HEAD` at
  `64fa1a7f6e38cff75c207b2acf7d9d6d51a71a25`.
- `https://github.com/shady2k/madarch-product` cloned read-only for the
  registry only.
- Product: `MADARCH_HOME=/tmp/madarch-walk-self/home bun scripts/madarch.ts
  init --home /tmp/madarch-walk-self/home --port 18451 --no-open --json` —
  returned at once and printed the product (`/tmp/madarch-walk-self/home/engine`,
  id `f983ad4c-d34b-4213-9dbf-26be5930d89f`) with the wiki served from pid on
  18451; the server was then stopped for the folder move below.
- `docs/kinds.yaml` copied from the madarch-product repository into
  `docs/kinds.yaml` of the new product and committed (`c278a79`). It is a
  **document-kinds** registry: Vision, Roadmap, Milestone, Source, Hypothesis,
  Open question, Prototype, Result, User story, Use case, Product requirement,
  Decision, Design record, Architecture, Capability, Change record,
  Exploration, Practice (18 kinds with stages and links, contract version 1).
  It carries **no code kinds** (no Service, Module, Store, Data Entity), so the
  fill extracts madarch's documents kind-registry-wise; per the brief nothing
  was invented. Which code kinds madarch's own wiki should have is an open
  registry question the owner holds (checkpoint 1 met the same boundary with
  the training repository's event bus).
- One setup fact worth keeping: `init` connects the checkout as a **symlink**
  under `repos/`, but a fill start refuses it —
  `Connected repository is not a Git root: ~/repos/engine` (src/product/fill.ts:60
  requires `git rev-parse --show-toplevel` to equal the repo path itself; a
  symlink fails the string comparison). The clone was therefore moved into
  `product/repos/engine` (workspace.yaml `moved: true`, the manifest shape
  `repo add --mode move` writes) and init's committed product was kept. A walk
  run through `repo add --mode move` from the start would not meet this.

## The fill run

```sh
cd /tmp/madarch-walk-self/home/engine
bun repos/engine/scripts/madarch.ts fill --agent omp --model shady2k-gateway/glm-5.3-flash-auto \
  --omp-executable /tmp/madarch-walk-self/omp-wrapper.sh \
  --omp-extension /home/dev/.omp/plugins/node_modules/pi-extension-shady2k-gateway/index.js \
  --max-units 150 --json
```

The wrapper (checkpoint-2's, retargeted) tees every omp stream into
`/tmp/madarch-walk-self/omp-calls/`. Run state and logs:
`/tmp/madarch-walk-self/home/engine/.madarch/fill/`, logs beside it
(`fill.log`, `fill-resume.log`), launch stamps in
`/tmp/madarch-walk-self/fill-start.txt`.

| start | run id | engine | wall | counted calls | outcome |
| --- | --- | --- | --- | --- | --- |
| run 1 | `4f540480` | `64fa1a7f` | 21:09:01.550–21:09:26.129 Z, 24.6 s | 1 | inventory + **317 index units complete deterministically**; claims blocked on spawn: `E2BIG: argument list too long, posix_spawn <wrapper>`; run `blocked` |
| resume 1 | `89eaaa48`, same chain `4f540480` | `64fa1a7f` | 21:12:51.173–21:12:59.218 Z, 8.0 s | 1 (total 2) | all 318 deterministic units reused (inventory + 317 index) with matching input hashes; claims unit attempt 2 re-blocked with the identical `E2BIG`; run `blocked` |

Not one omp call was ever executed: the wrapper has zero call streams on both
starts. The budget counted otherwise — `.madarch/fill/agent-calls.json` reads
`calls: 2` (one per `agentBudget.dispatch`, before any exec), so a spawn that
never starts still spends the chain cap; the chain carries **2 of 150** counted
dispatches and can resume under the same caps once the cause lands. Neither cap
of the owner authorization (150 calls, 90 minutes) was reached; total agent
wall time 32.6 s of the two attempts.

## What blocked and why

The claims unit is one agent call for the whole repository, and its prompt
embeds the entire source tree:

- `src/product/fill.ts:114` (abs. path of the snapshot:
  `/tmp/madarch-walk-self/home/engine/repos/engine/src/product/fill.ts`)
  assembles `claimsPrompt` = repository-claims template + the registry
  + `JSON.stringify(allSources)` + the inline materials.
- `src/product/fill.ts:93` builds `allSources` from **every file** of the
  pinned tree, each file with its full text (`git show <commit>:<path>`).
- `src/product/fill-agents.ts:13` (`agentCommand`), omp branch, passes the whole prompt
  as the **last argv entry**; `src/product/fill-agents.ts:56` spawns it.

For madarch at `64fa1a7f`: 943 files, 10,674,715 blob bytes
(`git ls-tree -r -l`), plus materials — about 10.7 MB in one argument. Linux
refuses any single argv or env string above `MAX_ARG_STRLEN` 131072 bytes, and
this machine's `getconf ARG_MAX` is 2097152: `posix_spawn` returns `E2BIG`
before the wrapper's first byte runs. Deterministic on resume — the second
start reused every completed unit (the resume machinery works exactly as
designed, checkpoint 1 and 2 behaviour) and blocked identically at claims.
grep over `src/product/` (2026-10-17) finds no chunking, no per-file claims
units, no stdin/file prompt path. The training-repository checkpoints never
saw this because that repository is ~50 KB of sources.

Filed as **madarch-tzte.16** (finding, under madarch-tzte, backlog gate green
after filing): the fix needs the claims call's prompt bounded (chunking or a
file/stdin-streamed prompt) and a named unit outcome for a prompt the OS
refuses, not the raw `E2BIG`. The walk's success signal — the owner reads the
wiki madarch made of madarch — cannot be met until it lands.

## What the wiki shows

Serving detached (`nohup`):

- **Address:** `http://127.0.0.1:18452` — serves the product
  `/tmp/madarch-walk-self/home/engine` from home
  `/tmp/madarch-walk-self/home`; the product's reading route answers 200
  (checked `curl -s -o /dev/null -w "%{http_code}"
  http://127.0.0.1:18452/p/engine/docs/kinds.yaml` → 200).
- **SSH tunnel:** `ssh -L 18452:127.0.0.1:18452 dev@192.168.0.25`.
- The wiki shows the product's **pre-fill** committed docs: a reader sees the
  registry page (`docs/kinds.yaml`) and the product shell; the fill wrote no
  pages because it never passed the claims stage.

### Pages made by kind (titles)

None. The synthesis stage never ran; no page of any kind was produced by the
fill. The claims stage (which feeds synthesis) blocked on spawn before any
model answer existed.

### Open questions by type, with the five strongest

None produced (the claims stage is where typed questions are generated;
checkpoint 2 counted 24 of them for the training repository). The training
repository's five strongest from its run are recorded in checkpoint-2.md and
are quoted here only as the shape the madarch fill could not reach.

### Unverified assumptions count

0 produced — no claims were made, so nothing stands unverified. The product's
kinds-registry gap (no code kinds in the copied registry) is an open question
for the owner, not an assumption recorded in the wiki.

## Calls, time, tokens

Calls: 2 counted dispatches (0 executed), 2 of 150. Time: 24.6 s + 8.0 s of
run wall (32.6 s in agent-bound attempts), of the 90-minute authorization.
Tokens: none — no model output ever existed, and `parseUsage` had no stream to
parse; the omp wrapper's tee holds zero streams, which is itself the evidence
no call started.

## Verdict

The pipeline's deterministic half and its resume machinery are real and hold
at the scale the walk exercises (inventory 1 + 317 index units, one chain, two blocked starts, all
completed work reused). The claims stage cannot pass on a repository of
madarch's own size: one agent call is asked to read about 10.7 MB inline as a
single argv entry, about five times this machine's `getconf ARG_MAX`
(2097152) and over eighty times Linux's 131072-byte single-argument limit — the walk was stopped by the
engine, not by the model, the setup or the caps. Nothing was invented between
the setup and the report; the block, its cause and the fix shape are in
madarch-tzte.16, and the same product plus the same chain (2/150 counted) is
the honest restart point once the fix lands.

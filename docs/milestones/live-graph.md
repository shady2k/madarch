# live-graph — a registry the product is published into

Adopted 2026-10-01 (owner, after three Codex consultations). Precedes: `mvp`.

The MVP left the graph manual: a model is written and sent by hand, the wiki
is built from a repository checkout. This milestone makes madarch a
**registry of the product**: repositories author everything (models,
documents, the product corpus), a step after merge publishes it, and the
portal is built from pinned releases. The arrow is one-way — git authors,
madarch stores and answers; nothing flows back except read-only queries.

## Outcomes and acceptance

1. **Keep the registry's integrity** (madarch-l19). Products and sources
have stable opaque ids independent of repository URLs; published artifacts
are addressed by canonical digests; uploads are idempotent (the same
source+commit answers already stored) and immutable (the same source+commit
with different bytes is refused, naming the difference); the protocol
carries version compatibility and refuses outside its supported range.
   *Check:* through a real server on a scratch data folder: resending
identical bytes answers already stored and changes nothing; the same
source+commit with different bytes is refused; a client naming an
unsupported protocol version is refused with the supported range; ids
survive a source rename.
2. **Publish a product release over two sources** (madarch-bwt).
`product.yaml` names the product's member sources and the corpus custody
(today the single repository's `docs/product/`, movable later without
changing identity or URLs); a release is published atomically from one
manifest pinning every artifact by digest — never synthesized from the
latest received state — and publishing validates that every referenced
artifact exists and is intact; the landscape joins sources at the contract
boundary only; an id clash across sources is reported naming both sources,
never merged last-writer-wins; a thin portal builds from a pinned release
(shared navigation, product overview, per-source namespaces).
   *Check:* with the real repository as one source and a synthetic second
source: a release manifest pins both sources' artifacts by digest;
publishing validates and records atomically; an id clash at the contract
boundary refuses the release naming both sources; the portal builds from
the pinned release; changing one source and publishing a new release
rebuilds the portal without touching the other.
3. **Keep the graph current without hands** (madarch-tah). A pull-request
check verifies the model against the repository and records the release
digest it checked against; after merge a CI step sends the model and the
documents bundle (each repository declares its own document roots, default
`docs/`); one versioned CLI/container runs `check`, `send` and
`wiki build`, and the skill invokes it.
   *Check:* on a real repository: a pull request whose model contradicts
the code fails the check naming the evidence; the check's record names the
release digest; merging publishes model and documents with no manual step,
and a rebuilt portal reflects the merge.

## Exclusions

- Write authorization, tokens, single sign-on (madarch-toc). Owner decision
2026-10-01: not this milestone; the server stays on a private network, and
anyone who can reach it may write.
- Extraction plugins and the fact log's extracted layer (madarch-mv2);
full graph merging beyond the contract boundary; serving agents over MCP
(madarch-yhy).
- Time-travel portal builds (`--at T`), the glossary term registry
(`[[term:…]]` references, alias linting, local namespaces), a pre-commit
hook installer, polished skill packaging.
- Pull-request comments on the git hosts.
- The update path's memory defect (madarch-8iw: about 115 KB per update,
the buffer pool full after about 5000 updates without a rebuild). Owner
decision 2026-10-07: removed from outcome 1 and deferred, since nothing in
this milestone waits on it; revisit before outcome 3 starts, as a server fed
by CI reaches the bound within days.

## Scope decisions

- Carried over from mvp and cleaned in this milestone's first run:
madarch-1xq (bug: temporary folders left behind by test suites),
madarch-06n, madarch-str (tooling chores).
- Finding budget 5, the config key `findingBudget` (the MVP absorbed
exactly 5).

## Next horizon

- Protect the server with tokens and single sign-on (madarch-toc).
- Extract facts with static plugins into the fact log (madarch-mv2).
- Serve the graph to agents over MCP (madarch-yhy).
- Serve the product's past and vocabulary: `--at T` portal builds and the
glossary term registry.


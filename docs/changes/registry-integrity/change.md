# Keep the registry trustworthy: identities, digests, immutable uploads, protocol versions

Change: registry-integrity
Base: 21494c6
Tasks: madarch-l19.1.1, madarch-l19.1.2, madarch-l19.2.1, madarch-l19.2.2, madarch-8iw
Kind: behavior

## Intent
Today the server trusts senders: two sends of the same source and commit are
assumed to be the same bytes, a repository that moves keeps no identity, and
a client and server that disagree about the protocol fail in fragments. After
this change the server is a registry whose contents can be addressed and
verified: every source has a stable opaque id the server assigned, surviving
a repository rename; every stored artifact is addressed by the SHA-256 digest
of its canonical serialization (JSON with keys sorted, no insignificant
whitespace); sending the same source and commit with identical bytes answers
already stored, and with different bytes is refused naming what differs; and
every request names its protocol version, answered within a stated supported
range or refused with it. The update path's memory defect is closed: a stream
of updates without a rebuild no longer fills the buffer pool.

Stories:
- As an engineer resending a model after a flaky network, I get "already
stored" and nothing changes, because the bytes are identical.
- As an engineer whose tool resent the same commit with different content, I
am refused with the digest of what is stored and of what I sent, not silently
overwritten.
- As a repository owner who renamed the repository, my next send keeps the
same source id, and the views and histories answer under it as before.
- As a tool author, I name my protocol version and am told the supported
range when mine is outside it, instead of parsing an error meant for another
shape.
- As the operator of a long-lived server, days of updates do not exhaust
memory without a rebuild.

## Out of scope
- Write authorization and tokens (owner decision 2026-10-01: private network
only; madarch-toc later).
- Digest-addressed fetching of artifacts (GET by digest), releases, manifests
and product identity: the `live-graph` charter's outcome 2 (madarch-bwt).
- Document bundles and portal building: outcome 3 (madarch-tah).

## Preserved contracts
- server/view: one view of an element at a depth, as Mermaid or LikeC4 text, is unchanged.
- server/store: a sent model is kept in the source's history, append-only; repeat-send still answers already stored for identical bytes.
- server/explains: every refusal names why and what to do.
- server/survives-restart: stored answers are byte-identical after restart.
- server/sources: the list keeps its fields, adding the source id.

## Coverage
- server/identities: test, registry-integrity
- server/immutability: test, registry-integrity
- server/protocol: test, registry-integrity
- server/view: test, registry-integrity
- server/store: test, registry-integrity
- server/explains: test, registry-integrity
- server/survives-restart: test, registry-integrity
- server/sources: test, registry-integrity
- graph-queries/bounded-update-memory: test, registry-integrity

## Design and decisions

- Digest: SHA-256 over canonical JSON — keys sorted by code point, no
  insignificant whitespace, UTF-8, numbers as serialized by `JSON.stringify`
  of the parsed value. Frozen now (consultation 2026-10-01) so later
  artifacts address the same bytes the same way.
- Source id: assigned by the server on first send (opaque, stable, not
  derived from the name); the name stays what it was for display and for
  view requests. A rename is recorded as a claim: the new name is bound to
  the existing id, the old name answers as an alias (or redirects), and no
  second id is ever created for one repository.
- Protocol version: one integer field in every request body and every
  answer, starting at the current shape as version 1; a request outside the
  supported range is refused with the range named. Compatible additions bump
  nothing; incompatible ones raise the minimum.
- The immutability refusal compares the digest of the stored artifact with
  the digest of the incoming bytes and names both, plus source, commit and
  field-level difference where the check already reports one.

## Rationale
The live-graph charter adopted 2026-10-01 makes madarch a registry the
product publishes into; a registry is only as good as its integrity rules.
The identity, digest and protocol decisions above were settled with the
owner and three Codex consultations on 2026-10-01 and recorded in the
charter's Scope decisions.

# Neutral repository names in examples and current documents

Change: madarch-l2f
Base: cf194a3c38e84832361d656c524fe6c3b61b4bcd
Tasks: madarch-l2f
Kind: behavior

## Intent

Keep madarch's code, tests, messages and current documents independent of any
other repository or personal infrastructure. Use neutral example sources, and
make the server end-to-end test build its checked source in its own scratch
directory so it runs on any clone.

## Out of scope

Historical change records, milestone charters and decision records remain as
written. No behavior of the server or send command changes.

## Rationale

The previous examples tied the server's current requirements and product
messages to a repository unrelated to madarch. The owner directed that current
code and documents name no other repository or personal infrastructure. A
neutral example preserves the requirements while making the examples reusable.

## Changes to requirements

- server/send: replace the named origin and source example with
  `github.com/acme/shop`.
- server/view: use `github.com/acme/unknown` as the source not sent, while
  listing the held `github.com/acme/shop`.
- server/explains: use `github.com/acme/shop` in the source-name example.
- server/sources: replace the named source examples with `github.com/acme/shop`.
- server/survives-restart: replace the named source example with
  `github.com/acme/shop`.
- server/identities: replace the named source example with
  `github.com/acme/shop`.
- server/immutability: replace the named source example with
  `github.com/acme/shop`.

## Preserved contracts

- server/store: history storage and source identifiers are unchanged.
- server/serves-wiki: wiki serving is unchanged.
- server/protocol: protocol negotiation is unchanged.

## Coverage

- server/send: static, test, mutation, review
- server/store: test
- server/view: test
- server/explains: test
- server/sources: test
- server/serves-wiki: test
- server/survives-restart: test
- server/identities: test
- server/immutability: test
- server/protocol: test

## Blocking questions

None.

## Design and decisions

The end-to-end fixture uses the existing complete model-check test factory,
which creates a temporary git repository with evidence that passes the real
model check. The test supplies a neutral origin and invokes the real send
command against the server. A committed guard scans current source, tests,
scripts, examples and system documents for non-example repository sources and
absolute home paths; it never encodes the outside names it rejects.

## Acceptance evidence

Recorded with the task after local checks and independent review.

## DONE WHEN

The task's acceptance criteria hold, including the committed neutral-name
guard and the scratch-repository server end-to-end run.

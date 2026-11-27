# Serialize startup bindings on one SQL executor

Change: madarch-64o5.179
Base: f1c275289ba34eec5240a11aa573cabb76cac256
Tasks: madarch-64o5.179
Kind: no-behavior

## Intent

Keep one source UID when overlapping startup calls share a transaction. Each
call gets its own result, including a contract validation failure.

## Out of scope

Installation lifecycle and assertion selection continue to follow decision 0039.

## Rationale

A transaction can acquire the same PostgreSQL advisory lock more than once.
Queue startup calls on the shared SQL executor so the first installation is
visible to subsequent calls. The queue waits for each call to settle.

## Changes to requirements

None.

## Preserved contracts

- server/identities: overlapping startup calls reuse the source UID for their producer and product.

## Coverage

- server/identities: static, test, review

## Where it is seen

Kind: command
Place: `bun test test/startup-binding.test.ts`

1. Start overlapping bindings in one transaction and verify that both use the same source UID.
2. Queue a valid startup behind a contract error and verify that the valid call binds.
3. Roll back the initial installation and verify reuse after a second connection commits it.

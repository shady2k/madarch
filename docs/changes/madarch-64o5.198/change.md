# Replay MCP retractions with optional evidence locators

Change: madarch-64o5.198
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.198
Kind: no-behavior

## Intent

An MCP client can retract with evidence whose locator is omitted and receive the
same result when it retries the request. An invalid locator gets a field-level
schema refusal.

## Rationale

The published input contract makes the locator optional. The durable operation
compares a retry against the canonical request in its receipt. Omit absent
request options from that comparison, as the queue does on first submission.

## Out of scope

Author provisioning and the evidence locator contract.

## Changes to requirements

None.

## Preserved contracts

- server/explains: a malformed MCP evidence locator is refused with the field at fault and the expected value type.

## Coverage

- server/explains: test

## Where it is seen

Kind: request
Place: the retract tool in madarch mcp

1. Create a record, then retract it using evidence without a locator.
2. Replay the request with the same identity and check that the receipt is returned.
3. Send a locator with a non-text path and check that the response identifies the field and expected type.

## Blocking questions

None.

# Every I/O path runs inside a span, and the io-spans debt is zero

Change: madarch-64o5.146
Base: 46459a319240b88b5a218c07ee0646ba0ef28856
Tasks: madarch-64o5.146
Kind: no-behavior

## Intent

The owner's rule is that code is instrumented on every path, so slowness and memory are answered from the trace (2026-11-07), and observability is part of the foundation before any lasting data (decision 0039 item 22). The io-spans gate of madarch-64o5.121 listed 282 file, network, database and process calls outside a span as debt. Each now runs inside a span named for what it does, with the attributes that answer what, where and how big (path, bytes, rows, exit code); the gate's list for that rule is empty.

## Out of scope

A server-side trace of the browser (the wiki records its spans in the page's performance timeline; shipping them to the server needs its own design); reducing trace volume where a statement now carries a query span beside the adapter's statement span.

## Rationale

Every listed call is wrapped where it stands; no behaviour changes, and the suites pass as before. The gate refuses a new unspanned call from now on.

## Preserved contracts
- fill-orchestrator/attempt: units run as before; only spans are added around their I/O.
- fill-stages/configuration: the manifest is read as before.

## Coverage
- fill-orchestrator/attempt: static, test, mutation, review
- fill-stages/configuration: static, test, mutation, review

## Where it is seen

Kind: internal
Place: the trace files of a run and the architecture check
Reason: nothing a person reaches changes; the trace gains a span for every I/O call.

1. A developer opens a run's trace and finds every file, database, network and process call as a span with its attributes.

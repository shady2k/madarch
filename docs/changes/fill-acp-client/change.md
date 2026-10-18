# madarch drives an agent over ACP: one process, one session per unit, streamed updates, tokens as reported, cancel

Change: fill-acp-client
Base: 82d5edbb
Tasks: madarch-tzte.22.1
Kind: behavior

## Intent
The fill of decision 0026 drives coding agents over the Agent Client Protocol:
madarch starts an agent, hands it a session with the unit's MCP server, sends the
unit's prompt and reads what the agent reports back. This change lands the first
slice of that — the client module the fill's agent stages build on: start a
process and initialize it, create one session with the given MCP servers, send
one prompt and stream its updates (messages, thoughts, tool calls, the context
window), read the session's token accounting as the agent reports it or say that
none was reported, and cancel a turn. It also lands the probe: which agents on
this machine connect over ACP, and for one that is missing, how it would be
installed and how large that is. `madarch fill --probe-acp` prints it. Tests
drive a fake ACP agent — a program speaking the protocol's JSON-RPC over stdio,
written by hand rather than from the library the client uses — so the client is
checked against the protocol and not against itself.

## Rationale
The task named two ways to reach ACP: the official TypeScript library when one
exists and works under Bun and in the compiled binary, otherwise a hand-written
JSON-RPC client. The library exists — `@agentclientprotocol/sdk` 1.9.0, the
protocol's own TypeScript implementation, with `zod` as its peer dependency —
and both were measured before it was taken: a client built on it answers a
hand-written agent under `bun run`, and the same code inside `bun build
--compile` works too — a binary compiled on 2026-10-18 from an entry that only
imports the client answered the hand-written fake agent's `initialize` and ran
one prompt turn in it (protocol version 1, stop reason `end_turn`, 30 input and
12 output tokens as reported, exit 0), and madarch's own compiled binary grows by
278 528 bytes for the client, the library and `zod` (91 256 288 → 91 534 816
bytes). Its README says nothing about Bun or
compiling, so the measurement, not its documentation, is the evidence. The probe's catalogue comes from the protocol's
own registry read on 2026-10-18: Claude Code through `@agentclientprotocol/claude-agent-acp`
(a later name for Zed's `claude-code-acp`, which the probe still accepts), Codex
through `@agentclientprotocol/codex-acp`, pi through `pi-acp`; omp is the one
agent this machine carries itself — `omp acp` — and answers an `initialize`
handshake, which is why it is the one agent the probe reports connected here.
Nothing was installed: the task's instruction was to report a missing adapter's
install command and size, not to install it.

A second measurement decided how the process ends: an agent's own helpers inherit
the connection's pipes, so waiting for the stream to close can wait forever, and
an agent left to itself can outlive the unit. The client starts the agent in its
own process group, treats the process's exit as the end of the connection, and
signals the whole group on close — SIGTERM, then SIGKILL after two seconds — so a
unit's helpers end with it. The test starts a helper that holds the pipes and
asserts that both are gone.

## Out of scope
- The unit's limits and how they are enforced — the 272K window, the wrap at
  70% and the stop at 80%, the turn and time caps, the split of a scope — and
  the MCP server itself: stage madarch-tzte.22's later tasks. This change reads
  and keeps the context window an agent reports, which is what those limits are
  read from.
- Any real agent prompt on this machine, and installing any adapter.
- The fill stages that run a unit through this client and print its token
  accounting: they are stage madarch-tzte.22's later tasks.
- The first-fill wizard's agent choice and the fill's own stages: the probe is a
  command and a module here, and the wizard uses it in a later task.
- Deciding the architecture again: decisions 0026 and 0027 are taken.

## Changes to requirements
- product-wiki/acp-agent: madarch starts an agent over ACP, initializes it once, creates a session with the unit's MCP servers, sends one prompt and streams its updates, reports each session's tokens as reported or says none were, cancels a turn, and reports on a machine which agents connect over ACP without sending a prompt.

## Preserved contracts
- product-wiki/pages: the product's Markdown stays the truth in git; this change writes no page.
- product-repository/contract: no product kind, form or name enters the engine; the probe's catalogue names agents, not product data.

## Coverage
- product-wiki/acp-agent: test
- product-wiki/pages: test
- product-repository/contract: test

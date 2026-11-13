# Scripted declaration scenarios

`main.js` is copied into an ordinary locked product plugin by
`test/plugin-fill-scenarios.test.ts`. The test writes its imported `scenario.js`
with the output contract, selected test mode, and authored file records.
The records are read from the fixture repository before locking; this fixture
is not the pending native Git file producer. The process uses the real SDK,
plugin host, selected-output access checks and orchestrator publication.
No ACP adapter or model is used. The enabled wildcard gap agent is the bundled
ordinary locked plugin. No adapter is provided, so both metadata and a refused
agent invocation detect unexpected scheduling.

Run with the project's usual PostgreSQL test setup and
`MADARCH_PLUGIN_SANDBOX=off bun test test/plugin-fill-scenarios.test.ts`.
Do not raise runtime bounds for this fixture.

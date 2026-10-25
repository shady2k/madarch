import { expect, test } from 'bun:test';
import { stateMachinesOf } from '../src/knowledge/state-machines.js';

test('string examples and comments cannot create executable transition tables', async () => {
  const example = "const docs = `Example 😀\nconst transitions = { idle: { go: 'done' } };\n`;\n";
  expect(await stateMachinesOf('src/order.ts', example)).toEqual([]);
  expect(await stateMachinesOf('order.go', "var example = `\nvar transitions = map[Status]map[Event]Status{ Idle: { Go: Done } }\n`;")).toEqual([]);
  const real = await stateMachinesOf('src/order.ts', example + "const transitions = { idle: { go: 'done' } };\n");
  expect(real).toHaveLength(1);
  expect(real[0]!.lineStart).toBe(4);
  expect(real[0]!.transitions).toEqual([{from:'idle',to:'done',event:'go',line:4}]);
});

test('comment markers in quoted state values and escaped quotes remain data', async () => {
  const machines = await stateMachinesOf('src/order.ts', "const transitions = { idle: { go: 'https://example.invalid/done' } };\n");
  expect(machines[0]!.transitions[0]!.to).toBe('https://example.invalid/done');
  expect(await stateMachinesOf('src/order.ts', "const example = \"escaped \\\" quote\\nconst transitions = { idle: {go:'done'} };\";")).toEqual([]);
});


test('nested template examples never become state declarations, preserving the following real line', async () => {
  const example = "const docs = `outer ${`inner\nconst transitions = { idle: { go: 'done' } };\n`}`;\n";
  expect(await stateMachinesOf('src/order.ts', example)).toEqual([]);
  const real = await stateMachinesOf('src/order.ts', example + "const transitions = { ready: { start: 'running' } };\n");
  expect(real).toHaveLength(1);
  expect(real[0]!.lineStart).toBe(4);
  expect(real[0]!.transitions).toEqual([{ from: 'ready', to: 'running', event: 'start', line: 4 }]);
});


test('nested interpolation with escaped delimiters, comments and emoji preserves the following declaration', async () => {
  const example = "const docs = `😀 ${(() => { /* } ` */ return `nested ${'quoted'}`; })()} tail`;\n";
  const real = await stateMachinesOf('src/order.ts', example + "const transitions = { idle: { go: 'done' } };\n");
  expect(real).toHaveLength(1);
  expect(real[0]!.lineStart).toBe(2);
  expect(real[0]!.transitions[0]!.line).toBe(2);
});


test('an incomplete script is refused with its source path and line, not accepted as executable facts', async () => {
  await expect(stateMachinesOf('src/broken.ts', 'const docs = `unterminated\nconst transitions = { idle: { go: "done" } };')).rejects.toThrow('src/broken.ts:');
});

for (const expression of ['choose()', '...next', "ready || 'done'", "flag ? 'done' : 'failed'", "'done' + suffix", "`done${suffix}`", "['nested']", "{ target: 'done' }", "'done',, 'failed'"]) test(`executable transition array item is refused: ${expression}`, async () => {
  await expect(stateMachinesOf('src/transitions.ts', `const transitions = { idle: [${expression}] };`)).rejects.toThrow('src/transitions.ts:1: transition arrays accept only literal or reference items separated by commas');
});

test('complete literal and reference array items retain their states, comments and source lines', async () => {
  const [machine] = await stateMachinesOf('src/transitions.ts', "const transitions = { idle: [/* choose() is not code */ 'done', Status.Failed, `closed`,] };\n");
  expect(machine!.transitions).toEqual(['done', 'Status.Failed', 'closed'].map(to => ({ from: 'idle', to, event: null, line: 1 })));
});

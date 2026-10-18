/**
 * A program that connects to the fake agent, initializes, closes and returns —
 * nothing else. The test runs it as its own process: it can exit by itself
 * only when the close released every pipe the agent's helper inherited, so a
 * client that leaves one open is caught here rather than in a user's shell.
 *
 * Run as `bun close-and-return.ts <fake agent> <record file> <pid file> <helper record file>`;
 * it prints `helper <pid>` for the helper the agent left, and exits 0.
 */
import { readFileSync } from 'node:fs';
import { connectAcpAgent } from '../../../src/fill/acp.js';

const [agent, record, pidFile, helperRecord] = process.argv.slice(2);
const connection = await connectAcpAgent(
  { id: 'fake', command: process.execPath, args: [agent!, '--scenario', 'exit-with-helper', '--record', record!, '--pid-file', pidFile!] },
  { cwd: process.cwd(), timeoutMs: 10_000 },
);
await connection.initialize();
await connection.closed;
await connection.close();
let helper = 0;
try { helper = Number(readFileSync(helperRecord!, 'utf8').trim().split('\n')[0]); } catch { /* the agent started none */ }
console.log(`helper ${helper}`);

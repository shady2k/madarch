/** Effective environment and argv are observed in the child, never inferred from spawn options. */
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync(process.env.STARTUP_BOUNDARY_CONFIG!, 'utf8')) as { context: string; key: string; receipts: string };
const kind = process.argv[2]!;
const command = process.argv.slice(3);
const effective = JSON.stringify({ env: process.env, argv: process.argv });
appendFileSync(config.receipts, JSON.stringify({ kind, pgctl: kind !== 'unrelated', unrelated: kind === 'unrelated', pathAbsent: process.env.MADARCH_STARTUP_CONTEXT === undefined && !effective.includes(config.context), keyAbsent: !effective.includes(config.key) }) + '\n');
const result = spawnSync(command[0]!, command.slice(1), { env: { ...process.env }, stdio: 'inherit' });
process.exit(result.status ?? 1);

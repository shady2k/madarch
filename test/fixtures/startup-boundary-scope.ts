/** Fake systemd transport, not a fake Madarch role. */
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const config = JSON.parse(readFileSync(process.env.STARTUP_BOUNDARY_CONFIG!, 'utf8'));
const args = process.argv.slice(2); const at = args.indexOf('--');
appendFileSync(config.receipts, JSON.stringify({ delegatedAttempt: true, pathPresent: process.env.MADARCH_STARTUP_CONTEXT === config.context }) + '\n');
if (config.mode === 'fallback') {
 // The daemon command is taken after the pid file by meaning, not by a fixed offset: what a scope puts before the pid
 // file changed once already (madarch-4ag1 replaced `/bin/sh -c` with `/bin/sh <receipt script>`), and a stale offset
 // ran the wrong program instead of failing loudly.
 if (at < 0) throw new Error(`${import.meta.path}:11: the delegated scope command has no '--' before its words`);
 const pidAt = args.findIndex((word, index) => index > at && basename(word).startsWith('.madarch-daemon-pid-'));
 if (pidAt < 0) throw new Error(`${import.meta.path}:13: no .madarch-daemon-pid- word follows the delegated scope command's '--'`);
 const words = args.slice(pidAt + 1);
 if (words.length === 0) throw new Error(`${import.meta.path}:15: no command words follow the delegated scope command's pid file`);
 const child = Bun.spawn([...words, '--help'], { env: { ...process.env }, stdout: 'inherit', stderr: 'inherit' });
 await child.exited;
 process.exit(1); // no pid receipt: production's fallback remains responsible for the next attempt
}
const child = Bun.spawn(args.slice(at + 1), { env: { ...process.env }, stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);

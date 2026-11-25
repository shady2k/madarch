/** Fake systemd-run that hands the delegated scope's receipt a `$` instead of a pid, then runs the daemon command. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const config = JSON.parse(readFileSync(process.env.STARTUP_BOUNDARY_CONFIG!, 'utf8'));
const args = process.argv.slice(2); const at = args.indexOf('--');
if (at < 0) throw new Error(`${import.meta.path}:5: the delegated scope command has no '--' before its words`);
// The words after `--` are `/bin/sh <receipt script> <pid file> <daemon command…>`: the pid file is found by meaning, not
// by a fixed offset, because madarch-4ag1 replaced the `-c` script word with a script file (its content is never argv).
const pidAt = args.findIndex((word, index) => index > at && basename(word).startsWith('.madarch-daemon-pid-'));
if (pidAt < 0) throw new Error(`${import.meta.path}:8: no .madarch-daemon-pid- word follows the delegated scope command's '--'`);
const script = args[pidAt - 1];
if (script === undefined) throw new Error(`${import.meta.path}:10: the delegated scope command names no receipt script before its pid file`);
// The receipt script is the one production wrote beside the pid file; this fake scope rewrites its own copy of the text
// so the receipt holds `$`, then runs the daemon command exactly as production's script would.
writeFileSync(script, `echo '$' > "$1" || exit 1\nshift\nexec "$@"\n`, { mode: 0o600 });
appendFileSync(config.receipts, JSON.stringify({ delegatedAttempt: true }) + '\n');
const child = Bun.spawn(args.slice(at + 1), { env: { ...process.env }, stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);

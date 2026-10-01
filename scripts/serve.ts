/**
 * The server's command line: `bun scripts/serve.ts --data <folder>
 * [--host 127.0.0.1] [--port 4180]`. The folder is required — it names
 * where the sources' history files live, and a missing input is an error,
 * never a temporary default. The server listens on 127.0.0.1 unless
 * `--host` says otherwise (decision 0012). One line per request goes to
 * standard output; a failure of the server itself is logged at error
 * level on standard error. Exits 2 naming what is wrong when the
 * arguments or the data folder cannot be used; otherwise it serves until
 * it is killed.
 */
import { startServer } from '../src/index.js';

const USAGE = 'usage: bun scripts/serve.ts --data <folder> [--host 127.0.0.1] [--port 4180]';

function main(args: readonly string[]): number {
  let data: string | undefined;
  let host: string | undefined;
  let portText: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--data') {
      data = args[i + 1];
      if (data === undefined) {
        console.error('the --data flag needs a value');
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--data=')) {
      data = arg.slice('--data='.length);
    } else if (arg === '--host') {
      host = args[i + 1];
      if (host === undefined) {
        console.error('the --host flag needs a value');
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      portText = args[i + 1];
      if (portText === undefined) {
        console.error('the --port flag needs a value');
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--port=')) {
      portText = arg.slice('--port='.length);
    } else if (arg.startsWith('--')) {
      console.error(`unknown option "${arg}"`);
      console.error(USAGE);
      return 2;
    } else {
      console.error(`unexpected argument "${arg}"`);
      console.error(USAGE);
      return 2;
    }
  }
  if (data === undefined) {
    console.error(`the --data flag is required: it names the folder the server keeps its sources' history files in`);
    console.error(USAGE);
    return 2;
  }
  let port: number | undefined;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`--port ${JSON.stringify(portText)} is not a whole port number between 0 and 65535`);
      return 2;
    }
  }

  try {
    const server = startServer({ dataFolder: data, host, port });
    console.log(`the server listens on ${server.url} — POST /models, GET /sources, POST /views`);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));

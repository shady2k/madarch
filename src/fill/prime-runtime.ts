import { withSpanSync } from '../obs/trace.js';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Machine-provided launch settings validated before prime-agent starts. */
export interface PrimeRuntime {
  socket: string;
  provider: string;
  model: string;
  env: Record<string, string>;
}

/** Reads and validates the ready runtime so madarch can safely launch its machine-owned ACP agent. */
export function primeRuntime(source: NodeJS.ProcessEnv = process.env): PrimeRuntime {
 const file = source.MADARCH_PRIME_RUNTIME_READY;
 if (!file) throw new Error('src/fill/prime-runtime.ts: MADARCH_PRIME_RUNTIME_READY is missing; set it to the full path of the machine runtime-ready file');
 if (!isAbsolute(file)) throw new Error(`src/fill/prime-runtime.ts: runtime-ready file path ${file} is not absolute`);
 let ready: any; try { ready = JSON.parse(withSpanSync('fs.read', { 'file.path': file }, (span) => { const text = readFileSync(file, 'utf8'); span.setAttribute('file.bytes', Buffer.byteLength(text)); return text; })); } catch { throw new Error(`src/fill/prime-runtime.ts: cannot read runtime-ready file ${file}`); }
 if (ready.phase !== 'ready') throw new Error(`src/fill/prime-runtime.ts: runtime-ready file ${file} is not ready`);
 if (!isAbsolute(ready.socket)) throw new Error(`Prime-agent socket path is invalid in ${file}`);
 try { const st=lstatSync(ready.socket); if (!st.isSocket() || st.dev !== ready.socket_dev || st.ino !== ready.socket_ino) throw new Error(); } catch { throw new Error(`src/fill/prime-runtime.ts: runtime-ready file ${file} names missing or changed daemon socket ${ready.socket}`); }
 withSpanSync('runtime.processes', { 'file.path': '/proc', 'runtime.processes': [...(ready.processes ?? []), ready.controller].filter(Boolean).length }, () => {
   for (const row of [...(ready.processes ?? []), ready.controller].filter(Boolean)) {
    try { const fields=readFileSync(`/proc/${row.pid}/stat`,'utf8').split(') ').slice(1).join(') ').trim().split(/\s+/); if(fields[0]==='Z'||fields[19]!==row.ticks) throw new Error(); } catch { throw new Error(`src/fill/prime-runtime.ts: daemon process ${row.pid} named by runtime-ready file ${file} is gone or changed`); }
   }
 });
 if (ready.env === null || typeof ready.env !== 'object' || Array.isArray(ready.env) || Object.values(ready.env).some((value) => typeof value !== 'string')) throw new Error(`Prime-agent runtime environment in ${file} must be an object of strings`);
 const provider=source.MADARCH_PRIME_PROVIDER, model=source.MADARCH_PRIME_MODEL;
 if (!provider) throw new Error(`src/fill/prime-runtime.ts: MADARCH_PRIME_PROVIDER is missing for runtime-ready file ${file}`);
 if (!model) throw new Error(`src/fill/prime-runtime.ts: MADARCH_PRIME_MODEL is missing for runtime-ready file ${file}`);
 return { socket: ready.socket, provider, model, env: ready.env };
}

/** Test-only startup stream reader. */
export interface StartupRecord {
 version: number; context: string; instance: string; pid: number; role: string; sequence: number;
 pair: string; phase: string; edge: string; clock: string; ns: string;
 operation?: string; traceId?: string; spanId?: string; domain?: string; startTicks?: string; collection?: string; keyId?: string; cluster?: string; outcome?: string;
 identity?: string; postmasterPid?: number; postmasterTicks?: string; holder?: string; probe?: string; command?: string; code?: number; signal?: string; childPid?: number;
}
export function collectStartup(text: string, expectedRoles: readonly string[] = []): { records: StartupRecord[]; incomplete: string[] } {
 const records: StartupRecord[] = []; const incomplete: string[] = [];
 if (text !== '' && !text.endsWith('\n')) incomplete.push('partial line');
 const sequences = new Map<string, number>(); const pairs = new Map<string, StartupRecord>();
 for (const line of text.split('\n')) {
  if (!line.startsWith('{')) continue;
  let record: StartupRecord;
  try { record = JSON.parse(line) as StartupRecord; } catch { incomplete.push('partial line'); continue; }
  if (record.version !== 1 || record.phase === undefined) continue;
  if (record.sequence !== (sequences.get(record.instance) ?? 0) + 1) incomplete.push('sequence gap');
  sequences.set(record.instance, record.sequence);
  const key = `${record.instance}:${record.pair}`;
  if (record.edge === 'begin') { if (pairs.has(key)) incomplete.push('duplicate begin'); pairs.set(key, record); }
  else if (record.edge === 'terminal') {
   const begin = pairs.get(key);
   if (begin === undefined) incomplete.push('missing begin');
   else if (begin.clock !== record.clock || begin.domain !== record.domain) incomplete.push('clock changed');
   pairs.delete(key);
  }
  else incomplete.push('unknown edge');
  records.push(record);
 }
 if (pairs.size > 0) incomplete.push('unmatched begin');
 for (const role of expectedRoles) if (!records.some(r => r.role === role)) incomplete.push(`missing child stream: ${role}`);
 return { records, incomplete };
}
export function comparableTime(a: StartupRecord, b: StartupRecord): boolean {
 return a.instance === b.instance ? a.clock === b.clock && a.domain === b.domain
  : a.clock === 'boottime' && b.clock === 'boottime' && a.domain !== undefined && a.domain === b.domain;
}
export function comparableCluster(a: StartupRecord, b: StartupRecord): boolean {
 return a.context === 'ready' && b.context === 'ready' && a.collection !== undefined && a.keyId !== undefined && a.collection === b.collection && a.keyId === b.keyId && a.cluster !== undefined && b.cluster !== undefined;
}

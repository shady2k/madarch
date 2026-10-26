import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import { lineForPath } from '../../model/yaml-position.js';
import type { GuideDiagnostic, GuideKind } from './model.js';
import type { GuideReceiptRead } from './host.js';

export interface GuideReceiptLocation { readonly file: string; lineAt(path: readonly (string | number)[]): number }
export type LocatedGuideReceiptRead = GuideReceiptRead & { readonly locations: readonly GuideReceiptLocation[] };
const MAX_RECEIPTS = 2400;
const MAX_BYTES = 1024 * 1024;

/** Complete product receipt files; trust is checked by a separate operator capability. */
export async function readGuideReceipts(productFolder: string, kind: GuideKind): Promise<LocatedGuideReceiptRead> {
  const folder = resolve(productFolder, 'docs', 'guide-walks', kind);
  const diagnostics: GuideDiagnostic[] = [];
  const receipts: unknown[] = [];
  const locations: GuideReceiptLocation[] = [];
  const error = (file: string, line: number, path: string, code: string, detail: string): void => {
    diagnostics.push({ file, line, path, code, message: `${file}:${line}: ${path}: ${detail}` });
  };
  let names: string[];
  try {
    const root = await realpath(productFolder);
    let cursor = resolve(productFolder);
    for (const part of ['docs', 'guide-walks', kind]) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('receipt folder contains a symbolic link');
    }
    const actual = await realpath(folder);
    const between = relative(root, actual);
    if (between === '..' || between.startsWith(`..${sep}`) || resolve(root, between) !== actual || (await lstat(folder)).isSymbolicLink()) {
      error(folder, 1, '$', 'receipt-path', 'receipt folder must be a real folder inside the product / папка свидетельств должна находиться внутри продукта');
      return { receipts, diagnostics, locations };
    }
    names = (await readdir(actual)).sort(byCodePoint);
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return { receipts, diagnostics, locations };
    error(folder, 1, '$', 'receipt-read', 'receipt folder is unavailable / папка свидетельств недоступна');
    return { receipts, diagnostics, locations };
  }
  if (names.length > MAX_RECEIPTS) {
    error(folder, 1, '$', 'receipt-bound', `receipt folder has ${names.length} entries, limit ${MAX_RECEIPTS}; nothing was shortened / список не сокращён`);
    return { receipts, diagnostics, locations };
  }
  let total = 0;
  for (const name of names) {
    const file = join(folder, name);
    if (!name.endsWith('.json')) { error(file, 1, '$', 'receipt-format', 'receipt entry must be JSON / свидетельство должно быть JSON'); continue; }
    try {
      const stats = await lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 32768) { error(file, 1, '$', 'receipt-bound', 'receipt must be a regular JSON file of at most 32768 bytes / требуется обычный JSON-файл не более 32768 байт'); continue; }
      total += stats.size;
      if (total > MAX_BYTES) { error(folder, 1, '$', 'receipt-bound', `receipt set exceeds ${MAX_BYTES} bytes; no partial set was accepted / неполный набор не принят`); return { receipts: [], diagnostics, locations: [] }; }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let source: string;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > 32768) { error(file, 1, '$', 'receipt-bound', 'receipt changed or exceeds its byte bound / файл изменился или превышает предел размера'); continue; }
        const buffer = Buffer.alloc(32769);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead > 32768 || read.bytesRead !== current.size) { error(file, 1, '$', 'receipt-bound', 'receipt changed or exceeds its byte bound / файл изменился или превышает предел размера'); continue; }
        source = buffer.subarray(0, read.bytesRead).toString('utf8');
      } finally { await handle.close(); }
      const lines = new LineCounter();
      const document = parseDocument(source, { lineCounter: lines, keepSourceTokens: true, uniqueKeys: true, merge: false });
      if (document.errors.length > 0) {
        for (const problem of document.errors) error(file, lines.linePos(problem.pos[0]).line, '$', 'receipt-json', 'invalid or duplicate JSON field / неверное или повторяющееся поле JSON');
        continue;
      }
      const value: unknown = JSON.parse(source);
      receipts.push(value);
      locations.push({ file, lineAt: (path) => lineForPath(document, lines, [...path]) });
    } catch {
      error(file, 1, '$', 'receipt-read', 'receipt is not readable strict JSON / свидетельство недоступно или не является строгим JSON');
    }
  }
  diagnostics.sort((a, b) => byCodePoint(a.file, b.file) || a.line - b.line || byCodePoint(a.path, b.path) || byCodePoint(a.code, b.code));
  return { receipts: diagnostics.length === 0 ? receipts : [], diagnostics, locations: diagnostics.length === 0 ? locations : [] };
}

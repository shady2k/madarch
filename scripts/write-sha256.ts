import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: bun scripts/write-sha256.ts <artifact>');
  process.exit(2);
}
const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
const line = `${digest}  ${basename(file)}\n`;
writeFileSync(`${file}.sha256`, line);
console.log(line.trim());

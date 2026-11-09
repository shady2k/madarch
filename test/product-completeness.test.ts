import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


let root: string | undefined;
function product(): string {
  root = mkdtempSync(join(tmpdir(), 'madarch-completeness-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'kinds.yaml'), [
    'contract: 1', 'stages:', '  - id: custom-build', '    name: Build', '    expected:', '      - user story', 'kinds: []', '',
  ].join('\n'));
  return root;
}
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('product completeness snapshots', () => {
  
  
  
  });

import { afterEach, describe } from 'bun:test';
import { rmSync } from 'node:fs';


let root: string | undefined;
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('product completeness snapshots', () => {
  
  
  
  });

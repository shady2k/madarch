import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('fill exposes agent and cap and promises prerequisites only', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/madarch.ts'), 'fill', '--help'], { stdout: 'pipe', stderr: 'pipe' });
  const [status, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(status).toBe(0);
  expect(text).toContain('--agent');
  expect(text).toContain('--token-cap');
  expect(text).not.toContain('kinds that need it');
});

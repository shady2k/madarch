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

for (const cap of ['0', '-1', '1.5', 'NaN']) {
  test(`fill refuses invalid token cap ${cap} before execution`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/madarch.ts'), 'fill', '--token-cap', cap], { stdout: 'pipe', stderr: 'pipe' });
    const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status).toBe(2);
    expect(error).toContain('command line:1: --token-cap');
  });
}

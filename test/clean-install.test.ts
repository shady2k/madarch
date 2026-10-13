import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'madarch-clean-install-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(command: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('clean install platform contracts', () => {
  test('Windows x64 package uses the exe artifact and wrapper selects the Windows package', () => {
    const bin = join(scratch, 'madarch-windows-x64.exe');
    const out = join(scratch, 'packages-windows');
    writeFileSync(bin, 'fixture binary');
    const made = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--os', 'win32', '--arch', 'x64', '--packages-dir', out, '--binary', bin]);
    expect(made.status).toBe(0);
    const platform = JSON.parse(readFileSync(join(out, '@madarch-win32-x64', 'package.json'), 'utf8')) as { name: string; main: string; os: string[]; cpu: string[] };
    expect(platform).toMatchObject({ name: '@madarch/win32-x64', main: 'bin/madarch.exe', os: ['win32'], cpu: ['x64'] });

    const wrapped = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--wrapper', '--packages-dir', out]);
    expect(wrapped.status).toBe(0);
    const wrapper = readFileSync(join(out, 'madarch', 'bin', 'madarch.js'), 'utf8');
    const wrapperPackage = JSON.parse(readFileSync(join(out, 'madarch', 'package.json'), 'utf8')) as { optionalDependencies: Record<string, string> };
    expect(wrapper).toContain("win32: 'win32'");
    expect(wrapper).toContain('Windows arm64');
    expect(wrapperPackage.optionalDependencies['@madarch/win32-x64']).toBe('1.2.3');
  });

  test('Windows arm64 is refused by name in both binary and npm package builders', () => {
    const binary = run('bun', ['scripts/build-binary.ts', '--version', '1.2.3', '--os', 'windows', '--arch', 'arm64']);
    expect(binary.status).toBe(2);
    expect(binary.stderr).toContain('Windows arm64');
    const pkg = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--os', 'win32', '--arch', 'arm64', '--packages-dir', join(scratch, 'unsupported')]);
    expect(pkg.status).toBe(2);
    expect(pkg.stderr).toContain('Windows arm64');
  });

  test('release tap step fails by secret name without attempting publication', () => {
    const missing = run('sh', ['scripts/publish-homebrew-tap.sh', join(scratch, 'no-formula.rb'), '1.2.3'], { HOMEBREW_TAP_TOKEN: '' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('HOMEBREW_TAP_TOKEN');
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('name: require the Homebrew tap token');
    expect(workflow).toContain('sh scripts/publish-homebrew-tap.sh');
    expect(workflow).not.toContain('npm publish');
    expect(readFileSync('Formula/madarch.rb', 'utf8')).toContain('brew install shady2k/tap/madarch');
    expect(readFileSync('Formula/madarch.rb', 'utf8')).toContain('(libexec / \"madarch-bin\").chmod 0755');
    expect(readFileSync('README.md', 'utf8')).toContain('brew install shady2k/tap/madarch');
    expect(readFileSync('scripts/install.sh', 'utf8')).toContain('brew install shady2k/tap/madarch');
  });
});

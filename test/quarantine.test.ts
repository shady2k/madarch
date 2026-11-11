import { afterEach, expect, test } from 'bun:test';
import { quarantined as selectRegistrar } from './quarantine.js';

const previous = process.env.MADARCH_QUARANTINE;
afterEach(() => {
  if (previous === undefined) delete process.env.MADARCH_QUARANTINE;
  else process.env.MADARCH_QUARANTINE = previous;
});

interface Registrar {
  (...args: unknown[]): void;
  skip: Registrar;
}
function registrar() {
  const calls: unknown[][] = [];
  const active: Registrar = Object.assign((...args: unknown[]) => { calls.push(['run', ...args]); }, { skip: undefined as unknown as Registrar });
  const skipped: Registrar = Object.assign((...args: unknown[]) => { calls.push(['skip', ...args]); }, { skip: active });
  active.skip = skipped;
  return { calls, active };
}

test('quarantine skips by default and only enables on the exact opt-in, preserving callback and bound', () => {
  const { calls, active } = registrar();
  const body = () => {};
  for (const value of [undefined, '', '0', 'true', '1']) {
    if (value === undefined) delete process.env.MADARCH_QUARANTINE;
    else process.env.MADARCH_QUARANTINE = value;
    selectRegistrar('madarch-64o5.14', active)('case', body, 321);
    expect(calls.at(-1)).toEqual([value === '1' ? 'run' : 'skip', 'case', body, 321]);
  }
});

test('quarantine refuses missing or malformed repair task ids even when disabled', () => {
  const { active } = registrar();
  for (const task of ['', 'madarch-', 'other-64o5.14', 'madarch-64o5.', 'madarch-64o5.fix', 'madarch-64o5.14\n']) {
    expect(() => selectRegistrar(task, active)).toThrow('tracker task id');
  }
});

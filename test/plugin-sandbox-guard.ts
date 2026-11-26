/**
 * The plugin sandbox's variable belongs to the process that started it, not to any test (madarch-64o5.74): a test that
 * sets `MADARCH_PLUGIN_SANDBOX` for its own plugin leaves every plugin of the rest of the run unconfined when it does
 * not restore it, and a case Bun stops at its deadline never reaches its own `finally`. A plugin host takes its
 * environment as an option (`PluginHost`'s `env`), or its fill takes `unconfined`, so no test needs the variable at all.
 *
 * This preload states the baseline before any test file loads and fails the case that changes it. The value is put back
 * afterwards, so one leak fails one case and the run still reports the rest.
 */
import { afterEach } from 'bun:test';

const NAME = 'MADARCH_PLUGIN_SANDBOX';
const baseline = process.env[NAME];
const WHERE = import.meta.path;

afterEach(() => {
  const held = process.env[NAME];
  if (held === baseline) return;
  if (baseline === undefined) delete process.env[NAME];
  else process.env[NAME] = baseline;
  throw new Error(`${WHERE}:1: a test left ${NAME}=${JSON.stringify(held)} where the run began with ${baseline === undefined ? 'it unset' : JSON.stringify(baseline)}: a plugin host takes its environment as an option and a fill takes "unconfined", never the test process's environment`);
});

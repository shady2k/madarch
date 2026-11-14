/**
 * The browser's stand-in for `node:module` (madarch-m38l.15): LikeC4's model entry begins with its rolldown runtime,
 * which calls `createRequire(import.meta.url)` as it initialises and hands the result to the CommonJS loaders it
 * carries for its CLI. A browser never loads a module that way, and `node:module` cannot be resolved into an app at
 * all — an unresolved import takes the first paint down with it — so the app aliases the module to this file: the
 * call stands, and a load that really needs it says what happened instead.
 */
export function createRequire(from: string): (id: string) => never {
  return (id: string) => {
    throw new Error(`createRequire(${JSON.stringify(from)})(${JSON.stringify(id)}) is a Node.js module load: the wiki app runs in the browser (wiki/app/src/shims/node-module.ts)`);
  };
}

// Rolldown's shared runtime creates one require at module load, even when no CLI path calls it. The browser shim
// returns a callable that reports an actionable error only if that Node-only path is used.
const require = createRequire(import.meta.url);
export default { createRequire, require };

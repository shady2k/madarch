/**
 * The browser's stand-in for `node:module` (madarch-m38l.15): the LikeC4 React runtime is bundled from the package's
 * own rolldown chunk, whose first line imports `createRequire` for the CLI's dynamic requires. A browser never calls
 * it, and a build cannot resolve `node:module` at all, so the app aliases the module to this file: an import that
 * stands and a call that says what happened instead of taking the page down.
 */
export function createRequire(from: string): (specifier: string) => never {
  // LikeC4's browser renderer imports the same rolldown runtime as its Node CLI. Creating the require function is
  // harmless and happens when the runtime loads; invoking it is Node-only and is the operation this shim rejects.
  return (specifier: string): never => {
    throw new Error(`require(${JSON.stringify(specifier)}) from ${JSON.stringify(from)} is a Node.js call: the wiki app runs in the browser (wiki/app/src/shims/node-module.ts)`);
  };
}

export default { createRequire };

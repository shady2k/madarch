/** The files of a plugin and precisely its declared dependency resolutions. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { ClosureRefusal } from './closure-refusal.js';

/** The path of one file, as the closure names it: relative, with `/` separators whatever the platform. */
function closurePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Every file under a folder, in code point order of their closure paths; a symlink is refused by name. */
export function walk(folder: string, root = folder): { path: string; file: string }[] {
  const found: { path: string; file: string }[] = [];
  if (lstatSync(folder).isSymbolicLink()) {
    throw new ClosureRefusal('closure-symlink', `${folder}:1: a symbolic link is not a closure folder`, folder);
  }
  const visit = (dir: string): void => {
    const names = readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name).sort(byCodePoint);
    for (const name of names) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new ClosureRefusal('closure-symlink', `${file}:1: is a symbolic link: a plugin's closure is its own files, and a link that answers elsewhere is not one of them. Replace it with the file it names, or keep the dependency inside the plugin's folder`, file);
      }
      if (stat.isDirectory() && name !== 'node_modules') visit(file);
      else if (stat.isFile()) found.push({ path: closurePath(root, file), file });
    }
  };
  visit(folder);
  return found.sort((left, right) => byCodePoint(left.path, right.path));
}


/** Package roots are resolved from the declaring package, never from the host's installation. */
export function dependencyFiles(folder: string, missing: (error: ClosureRefusal) => void = (error) => { throw error; }): { path: string; file: string }[] {
  const found: { path: string; file: string }[] = [];
  const visited = new Set<string>();
  const visit = (owner: string): void => {
    const manifest = join(owner, 'package.json');
    if (!existsSync(manifest)) return;
    let value: { dependencies?: Record<string, string> };
    try { value = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch (error) { throw new ClosureRefusal('plugin-dependency', `${manifest}:1: ${(error as Error).message}`, manifest); }
    for (const name of Object.keys(value.dependencies ?? {}).sort(byCodePoint)) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*$/i.test(name) || name.split('/').some((part) => part === '.' || part === '..')) {
        throw new ClosureRefusal('plugin-dependency', `${manifest}:1: invalid dependency package name ${JSON.stringify(name)}`, manifest);
      }
      if (name === 'madarch-plugin-sdk') continue;
      let at = owner;
      let dependency: string | undefined;
      while (at === folder || at.startsWith(`${folder}${sep}`)) {
        const candidate = join(at, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) {
          let ancestor = candidate;
          while (ancestor !== folder) {
            if (lstatSync(ancestor).isSymbolicLink()) throw new ClosureRefusal('closure-symlink', `${ancestor}:1: a symbolic link is not a closure dependency`, ancestor);
            ancestor = dirname(ancestor);
          }
          dependency = candidate;
          break;
        }
        if (at === folder) break;
        at = dirname(at);
      }
      if (dependency === undefined) {
        missing(new ClosureRefusal('plugin-dependency', `${manifest}:1: declared dependency ${JSON.stringify(name)} cannot resolve inside ${folder}`, manifest));
        continue;
      }
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      found.push(...walk(dependency, folder));
      visit(dependency);
    }
  };
  visit(folder);
  return found;
}


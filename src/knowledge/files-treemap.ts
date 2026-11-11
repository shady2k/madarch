/**
 * The treemap's plain shapes (madarch-j9ao.1): a file set folded into folders,
 * and the same set written as Mermaid's own `treemap` diagram. The server sends
 * the files, and both the ECharts map and the static picture are drawn from these
 * two builders, so the picture and the map can never disagree about a file.
 *
 * Nothing here reads the graph: the caller hands the files it read, and the
 * measure the area follows.
 */
import { byCodePoint } from '../model/order.js';

/** The measure the area of a cell follows, as the read names it. */
export type TreemapArea = 'lines' | 'bytes';

/** What the builders read of a file: its path and the two measures the area may stand for. */
export interface TreemapFileInput {
  path: string;
  lines: number | null;
  bytes: number | null;
}

/** The measure of one file under the chosen area: a file with no count has no area, and says so by holding 0. */
export function areaOf(file: TreemapFileInput, area: TreemapArea): number {
  const value = area === 'lines' ? file.lines : file.bytes;
  return value === null || value <= 0 ? 0 : value;
}

/** One cell of the map: a folder with the files it holds, or a file itself. */
export interface FilesFolderGroup<T extends TreemapFileInput = TreemapFileInput> {
  /** The folder's path, from the repository root. */
  path: string;
  name: string;
  files: readonly T[];
}

/**
 * The files of one folder as the map draws them: the folder's direct files and
 * the folders just below it, each with the files it holds. A folder is one cell
 * whose area is the sum of its files, so a click on it enters the folder; the
 * map shows one level at a time, which is what keeps a repository of thousands
 * of files readable and its drawing bounded.
 */
export function folderLevel<T extends TreemapFileInput>(files: readonly T[], root: string): { files: T[]; folders: FilesFolderGroup<T>[] } {
  const prefix = root === '' ? '' : `${root}/`;
  const here: T[] = [];
  const folders = new Map<string, { path: string; name: string; files: T[] }>();
  for (const file of files) {
    if (prefix !== '' && !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) { here.push(file); continue; }
    const name = rest.slice(0, slash);
    const path = prefix + name;
    const held = folders.get(path) ?? { path, name, files: [] };
    held.files.push(file);
    folders.set(path, held);
  }
  return {
    files: [...here].sort((left, right) => byCodePoint(left.path, right.path)),
    folders: [...folders.values()].sort((left, right) => byCodePoint(left.path, right.path)),
  };
}

/** A name as Mermaid's quoted text: the quotes and backslashes a quoted string cannot hold are escaped. */
function quoted(name: string): string {
  return `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** What one Mermaid picture draws, and what it leaves out because the page would be unreadable. */
export interface MermaidTreemap {
  source: string;
  /** The files drawn. */
  drawn: number;
  /** The files the picture leaves out; 0 when it draws every one with an area. */
  omitted: number;
}

/**
 * A file set as Mermaid 12's `treemap` diagram, at most `limit` leaves, the
 * largest first: a static picture of a repository of thousands of files is not
 * readable, and a picture that leaves files out says how many (`omitted`).
 * A folder with no drawn file under it is left out with them.
 */
export function mermaidTreemap(files: readonly TreemapFileInput[], root: string, area: TreemapArea, limit: number): MermaidTreemap {
  const withArea = files.filter((file) => areaOf(file, area) > 0);
  const ordered = [...withArea].sort((left, right) => areaOf(right, area) - areaOf(left, area) || byCodePoint(left.path, right.path));
  const drawn = ordered.slice(0, limit);
  const omitted = ordered.length - drawn.length;
  interface Node { name: string; children: Map<string, Node>; value: number }
  const top: Node = { name: root, children: new Map(), value: 0 };
  for (const file of drawn) {
    const segments = file.path.split('/');
    let cursor = top;
    for (let at = 0; at < segments.length - 1; at += 1) {
      const segment = segments[at]!;
      let child = cursor.children.get(segment);
      if (child === undefined) {
        child = { name: segment, children: new Map(), value: 0 };
        cursor.children.set(segment, child);
      }
      child.value += areaOf(file, area);
      cursor = child;
    }
    const name = segments[segments.length - 1]!;
    const leaf = cursor.children.get(name);
    if (leaf === undefined) cursor.children.set(name, { name, children: new Map(), value: areaOf(file, area) });
    else leaf.value += areaOf(file, area);
  }
  const lines = ['treemap'];
  const write = (node: Node, depth: number): void => {
    const indent = '    '.repeat(depth);
    const leaves = [...node.children.values()].filter((child) => child.children.size === 0).sort((left, right) => right.value - left.value || byCodePoint(left.name, right.name));
    const folders = [...node.children.values()].filter((child) => child.children.size > 0).sort((left, right) => right.value - left.value || byCodePoint(left.name, right.name));
    for (const leaf of leaves) lines.push(`${indent}${quoted(leaf.name)}: ${String(leaf.value)}`);
    for (const folder of folders) {
      lines.push(`${indent}${quoted(folder.name)}`);
      write(folder, depth + 1);
    }
  };
  if (root !== '') lines.push(`    ${quoted(root)}`);
  write(top, root === '' ? 0 : 1);
  return { source: `${lines.join('\n')}\n`, drawn: drawn.length, omitted };
}

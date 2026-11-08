/**
 * The ports one parsed code file's servers listen on (madarch-8bdc.2.4, step 1
 * of the port's prerequisites): the file's own tree is handed to the contracts
 * reader of its grammar, and the one shared rule picks the ports out of what it
 * states — a Go `http.Server`'s Addr through its constants, a TypeScript app's
 * `listen` port and the ports a top-level listen starts with.
 *
 * The rule itself stands in `src/extract/contracts/listening-ports.ts`, beside
 * the extractor whose `portsByService` map it builds, so the fill's per-file
 * fact and the driver cannot disagree. This module only chooses the reader: a
 * Go file is read by `readGoFile`, every other grammar by `readTsFile`.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {readGoFile} from '../../extract/contracts/go-code.js';
import {goListeningPorts, tsListeningPorts} from '../../extract/contracts/listening-ports.js';
import {readTsFile} from '../../extract/contracts/ts-code.js';

/** The ports one file's servers listen on, by the grammar its syntax tree was read with. */
export function listeningPortsOfTree(path: string, root: SyntaxNode, language: string): readonly string[] {
  return language === 'go' ? goListeningPorts(readGoFile(path, root)) : tsListeningPorts(readTsFile(path, root));
}

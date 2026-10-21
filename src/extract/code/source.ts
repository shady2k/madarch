/**
 * The files the code extractor reads, and what each one is: its language and
 * its role (code under test, a test, or a helper of tests). The classification
 * is by the path alone, so the same tree always gives the same roles.
 */
import { syntaxLanguageOf, type SyntaxLanguage } from '../../fill/stages/syntax-extract.js';

/** The two languages the extractor follows across files: Go and everything the TypeScript/JavaScript grammars read. */
export type CodeLanguage = 'go' | 'typescript';

/** What a source file is for: code, a test file, or a helper that lives with the tests. */
export type FileRole = 'code' | 'test' | 'test-support';

export interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly grammar: SyntaxLanguage;
  readonly language: CodeLanguage;
  readonly role: FileRole;
}

/** The language a path is read as, or `undefined` where no grammar of the stage reads it. */
export function codeLanguageOf(path: string): CodeLanguage | undefined {
  const grammar = syntaxLanguageOf(path);
  if (grammar === undefined) return undefined;
  return grammar === 'go' ? 'go' : 'typescript';
}

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go)$/;
const TEST_FOLDER = /(?:^|\/)(?:test|tests|__tests__)\//;

export function roleOf(path: string): FileRole {
  if (TEST_FILE.test(path)) return 'test';
  if (TEST_FOLDER.test(path)) return 'test-support';
  return 'code';
}

/** The folder of a repository path: everything before the last `/`, empty for a path at the root. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** The last segment of a repository path. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

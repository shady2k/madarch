/**
 * Errors are values, never thrown and never logged: a list of problems,
 * each naming where it was found. Later tasks extend the paths and
 * messages this module can produce, not its shape.
 */
export interface ModelError {
  /** Path of the file the problem was found in, relative to the repository root. */
  file: string;
  /** 1-based line number in that file. */
  line: number;
  /** Path to the offending value, e.g. `elements[0].owner`. Empty for whole-file problems. */
  path: string;
  message: string;
}

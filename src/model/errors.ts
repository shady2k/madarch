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

/**
 * A problem worth fixing that does not refuse the model, such as a relation
 * with no name. Named exactly the way a `ModelError` is, so a reader can show
 * both side by side; loading returns warnings beside the model, never
 * instead of it.
 */
export interface ModelWarning {
  /** Path of the file the problem was found in, relative to the repository root. */
  file: string;
  /** 1-based line number in that file. */
  line: number;
  /** Path to the value the warning is about, e.g. `relations[0]` or `relations[0].name`. */
  path: string;
  message: string;
}

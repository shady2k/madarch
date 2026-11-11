/** A plugin closure refusal, with the full source path and line. */
export class ClosureRefusal extends Error {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  constructor(code: string, message: string, file: string, line = 1) {
    super(message);
    this.name = 'ClosureRefusal';
    this.code = code;
    this.file = file;
    this.line = line;
  }
}


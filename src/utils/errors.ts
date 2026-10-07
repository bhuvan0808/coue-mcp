/**
 * Error types for COUE.
 *
 * Every error surfaced to a caller is a `CoueError` carrying a stable code, a
 * plain-language reason, and a recommendation. Internal failures are converted
 * into a generic message: stack traces and infrastructure details never leave
 * the server.
 */

export type CoueErrorCode =
  | 'INVALID_INPUT'
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'SOURCE_TOO_LARGE'
  | 'EMPTY_INPUT'
  | 'UNSUPPORTED_PATH'
  | 'TOO_MANY_MODELS'
  | 'INSUFFICIENT_METRICS'
  | 'ANALYSIS_TIMEOUT'
  | 'INTERNAL';

export class CoueError extends Error {
  readonly code: CoueErrorCode;
  readonly reason: string;
  readonly recommendation: string;

  constructor(code: CoueErrorCode, reason: string, recommendation: string) {
    super(`${code}: ${reason}`);
    this.name = 'CoueError';
    this.code = code;
    this.reason = reason;
    this.recommendation = recommendation;
  }

  /** The message shown to the user through Claude. */
  toUserMessage(): string {
    return [
      'COUE could not complete the request.',
      '',
      `Reason:\n${this.reason}`,
      '',
      `Recommendation:\n${this.recommendation}`
    ].join('\n');
  }
}

/** Convenience constructors for the limit errors, so messages stay consistent. */
export const errors = {
  emptyInput: (): CoueError =>
    new CoueError(
      'EMPTY_INPUT',
      'No files were supplied for analysis.',
      'Supply at least one source, configuration, dependency, test, or deployment file from the machine-learning project.'
    ),

  tooManyFiles: (count: number, max: number): CoueError =>
    new CoueError(
      'TOO_MANY_FILES',
      `The request contains ${count} files, which exceeds the supported maximum of ${max}.`,
      'Submit only the source, configuration, dependency, test, and deployment files relevant to the machine-learning application.'
    ),

  fileTooLarge: (path: string, max: number): CoueError =>
    new CoueError(
      'FILE_TOO_LARGE',
      `The file "${path}" exceeds the supported maximum of ${max} characters.`,
      'Omit large data files, notebooks with stored outputs, and model artifacts. COUE analyzes source and configuration files.'
    ),

  sourceTooLarge: (total: number, max: number): CoueError =>
    new CoueError(
      'SOURCE_TOO_LARGE',
      `The submitted project totals ${total} characters, which exceeds the supported maximum of ${max}.`,
      'Reduce the project to the relevant source and configuration files and try again.'
    ),

  unsupportedPath: (path: string): CoueError =>
    new CoueError(
      'UNSUPPORTED_PATH',
      `The file path ${JSON.stringify(path.slice(0, 80))} is empty, too long, or contains unsupported characters.`,
      'Supply project-relative paths such as "src/app.py" or "Dockerfile".'
    ),

  tooManyModels: (count: number, max: number): CoueError =>
    new CoueError(
      'TOO_MANY_MODELS',
      `The request contains ${count} models, which exceeds the supported maximum of ${max}.`,
      'Compare a smaller set of candidate models in a single call.'
    ),

  internal: (): CoueError =>
    new CoueError(
      'INTERNAL',
      'An unexpected error occurred while analyzing the request.',
      'Retry the request. If the problem persists, report it at https://github.com/bhuvan0808/coue-mcp/issues without including your source code.'
    )
};

/** Normalizes any thrown value into a CoueError, hiding internal details. */
export function toCoueError(err: unknown): CoueError {
  if (err instanceof CoueError) return err;
  return errors.internal();
}

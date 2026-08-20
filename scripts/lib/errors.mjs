// Exit codes and the single error class used across the caveman-ui-ux pipeline.
// Contract §4 — the CLI maps CavemanError.exitCode straight onto process.exit().

export const EXIT = { OK: 0, GATE_FAIL: 1, CONFIG: 2, TARGET: 3, DEPENDENCY: 4, EVALUATOR: 5, PRIVACY: 6 };

export class CavemanError extends Error {
  constructor(message, exitCode = EXIT.CONFIG, details = {}) {
    super(message);
    this.name = 'CavemanError';
    this.exitCode = exitCode;
    this.details = details && typeof details === 'object' ? details : { details };
  }
}

/** Throw a CavemanError carrying an exit code and machine-readable details. */
export function fail(message, exitCode = EXIT.CONFIG, details = {}) {
  throw new CavemanError(message, exitCode, details);
}

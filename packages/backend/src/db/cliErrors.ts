/**
 * A CLI precondition refusal (wrong target, bad flags, missing input). The CLI that catches it
 * logs the message and exits 2. This module deliberately imports nothing (design §9.5), so a CLI
 * can load it before the environment configuration is validated.
 */
export class CliPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliPreconditionError';
  }
}

import type { StandardSchemaV1 } from '@pothos/plugin-validation';

export type FieldError = { path: string[]; message: string };

/**
 * Invalid input, one entry per field: what the Validation plugin turns Zod issues into, and what
 * mutations return as a `ValidationError` union member (Errors plugin) instead of a GraphQL error.
 */
export class ValidationError extends Error {
  readonly fieldErrors: FieldError[];

  constructor(fieldErrors: FieldError[], message = 'Invalid input') {
    super(message);
    this.name = 'ValidationError';
    this.fieldErrors = fieldErrors;
  }

  static fromIssues(issues: readonly StandardSchemaV1.Issue[]): ValidationError {
    return new ValidationError(
      issues.map((issue) => ({
        message: issue.message,
        path: (issue.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)),
      })),
    );
  }
}

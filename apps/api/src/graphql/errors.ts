import type { StandardSchemaV1 } from '@pothos/plugin-validation';
import { GraphQLError } from 'graphql';

export type FieldError = { path: string[]; message: string };

/**
 * Invalid input, one entry per field (its path in the arguments, e.g. ["input", "title"]): what
 * the Validation plugin turns Zod issues into. A mutation returns it as a `ValidationError` union
 * member (Errors plugin); anywhere else it is a GraphQL error with code BAD_USER_INPUT, not masked
 * like unexpected errors, because the client needs to know what to fix.
 */
export class ValidationError extends GraphQLError {
  readonly fieldErrors: FieldError[];

  constructor(fieldErrors: FieldError[]) {
    super(`Invalid input: ${fieldErrors.map((e) => e.message).join('; ')}`, {
      extensions: { code: 'BAD_USER_INPUT', fieldErrors },
    });
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

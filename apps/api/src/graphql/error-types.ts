// Expected failures are data, not GraphQL errors: a mutation lists the ones it can return
// (`errors: { types: [...] }`, the Errors plugin) and clients select them with `__typename`.
// Anything else stays an unexpected error, masked in the response.
import { NotFoundError } from '@acme/core/errors';
import { builder } from './builder';
import { ValidationError } from './errors';

const ErrorInterface = builder.interfaceRef<Error>('Error').implement({
  description: 'An expected failure a mutation returns instead of its result',
  fields: (t) => ({ message: t.exposeString('message') }),
});

const FieldError = builder.objectRef<{ path: string[]; message: string }>('FieldError').implement({
  description:
    'One invalid field: its path in the arguments (e.g. ["input", "title"]) and what is wrong',
  fields: (t) => ({
    path: t.exposeStringList('path'),
    message: t.exposeString('message'),
  }),
});

builder.objectType(ValidationError, {
  name: 'ValidationError',
  description: 'The input was invalid; fieldErrors says where and why',
  interfaces: [ErrorInterface],
  fields: (t) => ({
    fieldErrors: t.field({ type: [FieldError], resolve: (error) => error.fieldErrors }),
  }),
});

builder.objectType(NotFoundError, {
  name: 'NotFoundError',
  description: 'A record the input refers to does not exist',
  interfaces: [ErrorInterface],
  fields: (t) => ({
    entity: t.exposeString('entity'),
    id: t.exposeID('id'),
  }),
});

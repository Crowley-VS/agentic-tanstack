// The Pothos schema builder. Importing it (or the schema) must never read the environment or open
// a database connection: `print-schema` runs with an empty environment. The database comes from
// the request context instead (`client: (ctx) => ctx.db`).
import type { Db, Relations } from '@acme/db';
import { relations } from '@acme/db';
import SchemaBuilder from '@pothos/core';
import ComplexityPlugin from '@pothos/plugin-complexity';
import DataloaderPlugin from '@pothos/plugin-dataloader';
import DrizzlePlugin from '@pothos/plugin-drizzle';
import ErrorsPlugin from '@pothos/plugin-errors';
import RelayPlugin from '@pothos/plugin-relay';
import ValidationPlugin from '@pothos/plugin-validation';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ValidationError } from './errors';

export type Context = { db: Db };

export const builder = new SchemaBuilder<{
  Context: Context;
  DrizzleRelations: Relations;
  DefaultFieldNullability: false;
  Scalars: { DateTime: { Input: Date; Output: Date } };
}>({
  // Order matters: Errors before Validation (so invalid input can be returned as a ValidationError
  // union member) and before Dataloader; Relay before Drizzle (drizzleConnection, drizzleNode).
  plugins: [
    ErrorsPlugin,
    ValidationPlugin,
    ComplexityPlugin,
    RelayPlugin,
    DataloaderPlugin,
    DrizzlePlugin,
  ],
  defaultFieldNullability: false,
  errors: {
    defaultTypes: [],
    // validation runs before the resolver: without this, its error would not reach the union
    unsafelyHandleInputErrors: true,
  },
  validation: {
    validationError: (result) => ValidationError.fromIssues(result.issues),
  },
  complexity: {
    defaultComplexity: 1,
    defaultListMultiplier: 10,
    limit: { complexity: 2000, depth: 10, breadth: 100 },
  },
  relay: {
    clientMutationId: 'omit',
    cursorType: 'String',
  },
  drizzle: {
    client: (ctx) => ctx.db,
    getTableConfig,
    relations,
    defaultConnectionSize: 20,
    maxConnectionSize: 50,
  },
});

builder.scalarType('DateTime', {
  description: 'An ISO 8601 timestamp in UTC, with milliseconds',
  serialize: (date) => date.toISOString(),
  parseValue: (value) => {
    const date = typeof value === 'string' ? new Date(value) : undefined;
    if (!date || Number.isNaN(date.getTime()))
      throw new TypeError('DateTime must be an ISO 8601 string');
    return date;
  },
});

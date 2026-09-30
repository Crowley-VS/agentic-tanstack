// Prints the schema as SDL, sorted, to the path given (the `print-schema` target writes
// packages/graphql/schema.graphql, the contract clients generate their types from). Needs no
// environment and no database: importing the schema has no side effects.
import { writeFileSync } from 'node:fs';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { schema } from './graphql/schema';

const out = process.argv[2];
if (!out) {
  console.error('usage: tsx src/print-schema.ts <output.graphql>');
  process.exit(1);
}
writeFileSync(out, `${printSchema(lexicographicSortSchema(schema))}\n`);
console.log(`[api] wrote ${out}`);

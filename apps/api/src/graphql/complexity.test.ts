// Every connection must price the rows a page can return. Its cost is its own multiplier (`notes`
// multiplies by the page size asked for) times its edges' multiplier, so one that sets neither
// prices a page of 50 like 10 rows, and one whose edges alone are set to 1 prices it as one row.
// The connections are found by walking the schema from Query, so a new one is checked here as is.
import { NOTE_LIMITS } from '@acme/validators/notes';
import { complexityFromQuery } from '@pothos/plugin-complexity';
import {
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLObjectType,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { schema } from './schema';

/** The largest page a connection serves (the builder's `maxConnectionSize`). */
const PAGE = NOTE_LIMITS.pageSizeMax;

type Field = GraphQLField<unknown, unknown>;
const isConnection = (field: Field) => getNamedType(field.type).name.endsWith('Connection');

/** A literal for a required argument: complexity is computed from the query, never executed. */
function sample(type: GraphQLInputType): string {
  const named = getNamedType(type);
  if (isEnumType(named)) return named.getValues()[0]!.name;
  if (named.name === 'ID' || named.name === 'String') return '"0"';
  if (named.name === 'Int' || named.name === 'Float') return '1';
  if (named.name === 'Boolean') return 'true';
  throw new Error(`No sample value for a required ${named.name} argument: add one here`);
}

/** `field(arg: value, …)`, with every required argument given. */
function call(field: Field, args: Record<string, string> = {}): string {
  const required = field.args
    .filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)
    .map((arg): [string, string] => [arg.name, sample(arg.type)]);
  const list = Object.entries({ ...Object.fromEntries(required), ...args })
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
  return list ? `${field.name}(${list})` : field.name;
}

/** Every connection field, with the shortest chain of fields from Query to its parent type. */
function connections() {
  const found: { name: string; path: string[]; field: Field }[] = [];
  const queue: [GraphQLObjectType, string[]][] = [[schema.getQueryType()!, []]];
  const seen = new Set<GraphQLObjectType>();
  while (queue.length > 0) {
    const [type, path] = queue.shift()!;
    if (seen.has(type)) continue;
    seen.add(type);
    for (const field of Object.values(type.getFields())) {
      const target = getNamedType(field.type);
      if (!isObjectType(target)) continue;
      if (isConnection(field)) found.push({ name: `${type.name}.${field.name}`, path, field });
      queue.push([target, [...path, call(field)]]);
    }
  }
  return found;
}

/** What one more field costs where `query` puts it: the product of the multipliers above it. */
function weight(query: (selection: string) => string) {
  const cost = (selection: string) => complexityFromQuery(query(selection), { schema }).complexity;
  return cost('__typename extra: __typename') - cost('__typename');
}

describe('connection complexity', () => {
  const found = connections();

  it('reaches every connection in the schema from Query', () => {
    const everywhere = Object.values(schema.getTypeMap())
      .filter(isObjectType)
      .flatMap((type) =>
        Object.values(type.getFields())
          .filter(isConnection)
          .map((field) => `${type.name}.${field.name}`),
      );
    expect(found.map((c) => c.name).toSorted()).toEqual(everywhere.toSorted());
    expect(everywhere).toContain('Query.notes');
  });

  it.each(found)(`$name prices a page of ${PAGE} as at least ${PAGE} rows`, ({ path, field }) => {
    // measured against the connection's parent, so a list above it does not count
    const inParent = (selection: string) =>
      `{ ${path.reduceRight((inner, step) => `${step} { ${inner} }`, selection)} }`;
    const perNode = weight((selection) =>
      inParent(`${call(field, { first: String(PAGE) })} { edges { node { ${selection} } } }`),
    );
    expect(perNode / weight(inParent)).toBeGreaterThanOrEqual(PAGE);
  });
});

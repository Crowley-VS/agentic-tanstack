// The executable schema: the builder plus every type module. Feature modules are imported here for
// their side effect of registering types on the builder.
import { builder } from './builder';
import './error-types';
import './notes';

builder.mutationType({});
builder.queryType({
  fields: (t) => ({
    apiVersion: t.string({
      description: 'The version of the running API (APP_VERSION, set at deploy time)',
      resolve: () => process.env.APP_VERSION ?? 'dev',
    }),
    readOnly: t.boolean({
      description:
        'True while the API rejects every mutation (READ_ONLY=true): clients can disable writes',
      resolve: (_root, _args, ctx) => ctx.readOnly,
    }),
  }),
});

export const schema = builder.toSchema();

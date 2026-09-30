// The executable schema: the builder plus every type module. Feature modules (e.g. ./notes, M3b)
// are imported here for their side effect of registering types on the builder.
import { builder } from './builder';

builder.queryType({
  fields: (t) => ({
    apiVersion: t.string({
      description: 'The version of the running API (APP_VERSION, set at deploy time)',
      resolve: () => process.env.APP_VERSION ?? 'dev',
    }),
  }),
});

export const schema = builder.toSchema();

#!/usr/bin/env node
// Entry point for turning a fresh copy of this template into your project:
//
//   node scripts/bootstrap.mjs                 interactive
//   node scripts/bootstrap.mjs --yes --scope @myco --name my-app
//   node scripts/bootstrap.mjs --help          every option (USAGE in bootstrap.ts)
//
// This tiny shim only checks the Node version (so old Node gets a readable error
// instead of a TypeScript syntax error), then runs bootstrap.ts via Node's
// built-in type stripping.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(
    `bootstrap: Node ${process.versions.node} is too old. This template needs Node 24+ ` +
      '(see .prototools / .node-version). Install it with proto, fnm, nvm or mise and retry.',
  );
  process.exit(1);
}
const { main } = await import('./bootstrap.ts');
await main();

// READ_ONLY=true: every mutation is rejected before it runs; queries keep working. The switch to
// flip when the public, unauthenticated board is being abused. Clients learn it beforehand from
// `Query.readOnly`, and from a write's error code READ_ONLY (@acme/validators/error-codes).
import { READ_ONLY } from '@acme/validators/error-codes';
import { getOperationAST, GraphQLError, OperationTypeNode } from 'graphql';
import type { Plugin } from 'graphql-yoga';

export function useReadOnly(enabled: boolean): Plugin {
  if (!enabled) return {};
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const operation = getOperationAST(args.document, args.operationName);
      if (operation?.operation !== OperationTypeNode.MUTATION) return;
      setResultAndStopExecution({
        errors: [
          new GraphQLError('The API is read-only right now: changes are not accepted.', {
            extensions: { code: READ_ONLY },
          }),
        ],
      });
    },
  };
}

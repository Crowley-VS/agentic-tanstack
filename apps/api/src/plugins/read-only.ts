// READ_ONLY=true: every mutation is rejected before it runs; queries keep working. The switch to
// flip when the public, unauthenticated board is being abused.
import { getOperationAST, GraphQLError } from 'graphql';
import type { Plugin } from 'graphql-yoga';

export const READ_ONLY_CODE = 'READ_ONLY';

export function useReadOnly(enabled: boolean): Plugin {
  if (!enabled) return {};
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const operation = getOperationAST(args.document, args.operationName);
      if (operation?.operation !== 'mutation') return;
      setResultAndStopExecution({
        errors: [
          new GraphQLError('The API is read-only right now: changes are not accepted.', {
            extensions: { code: READ_ONLY_CODE },
          }),
        ],
      });
    },
  };
}

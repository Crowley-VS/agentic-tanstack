// What every page needs to know about the API: whether it accepts writes (READ_ONLY=true turns
// them off). The root route loads it for every page; forms read it with useReadOnly().
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { graphql } from '../gql';
import { execute } from './graphql/execute';

const AppStatusQuery = graphql(`
  query AppStatus {
    readOnly
  }
`);

export const appStatusOptions = () =>
  queryOptions({
    queryKey: ['appStatus'],
    queryFn: ({ signal }) => execute(AppStatusQuery, undefined, { signal }),
  });

/** True while the API rejects writes: forms render disabled and the root shows a banner. */
export function useReadOnly(): boolean {
  return useSuspenseQuery(appStatusOptions()).data.readOnly;
}

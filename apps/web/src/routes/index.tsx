// The home page: the data-layer pattern end to end. The loader fills the query cache during SSR
// (the data is in the HTML), the browser hydrates it without refetching, and Refresh refetches
// through the BFF. The title limit proves workspace packages resolve from source (client and SSR).
import { NOTE_LIMITS } from '@acme/validators/notes';
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { graphql } from '../gql';
import { execute } from '../lib/graphql/execute';

const ApiVersionQuery = graphql(`
  query ApiVersion {
    apiVersion
  }
`);

const apiVersionOptions = () =>
  queryOptions({
    queryKey: ['apiVersion'],
    queryFn: ({ signal }) => execute(ApiVersionQuery, undefined, { signal }),
    select: (data) => data.apiVersion,
  });

export const Route = createFileRoute('/')({
  // Awaited, so SSR renders the data; returns nothing, since the dehydrated query cache already
  // carries it (returned loader data would be serialized a second time).
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(apiVersionOptions());
  },
  component: Home,
});

function Home() {
  const { data: version, refetch } = useSuspenseQuery(apiVersionOptions());
  return (
    <main>
      <h1>acme-app</h1>
      <p>API version {version}</p>
      <p>title max: {NOTE_LIMITS.titleMax}</p>
      <button type="button" onClick={() => void refetch()}>
        Refresh
      </button>
    </main>
  );
}

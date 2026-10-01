// The home page: the data-layer pattern end to end. The loader fills the query cache during SSR
// (the data is in the HTML), the browser hydrates it without refetching, and Refresh refetches
// through the BFF. The title limit proves workspace packages resolve from source (client and SSR).
import { toast } from '@acme/ui/components/sonner';
import { Skeleton } from '@acme/ui/components/skeleton';
import { NOTE_LIMITS } from '@acme/validators/notes';
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiStatus } from '../components/api-status';
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
  // a client-side navigation whose loader is slow
  pendingComponent: () => (
    <Page>
      <Skeleton className="h-24 rounded-xl" />
    </Page>
  ),
  component: Home,
});

function Home() {
  const { data: version, refetch, isRefetching } = useSuspenseQuery(apiVersionOptions());
  const refresh = async () => {
    const { isError } = await refetch();
    if (isError) toast.error('Could not refresh the API version');
    else toast('API version refreshed');
  };
  return (
    <Page>
      <ApiStatus version={version} refreshing={isRefetching} onRefresh={() => void refresh()} />
      <p className="text-sm text-muted-foreground">
        Note titles: up to {NOTE_LIMITS.titleMax} characters.
      </p>
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">acme-app</h1>
      {children}
    </main>
  );
}

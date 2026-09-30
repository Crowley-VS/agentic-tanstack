// The home page's API card. Presentational: the page owns the query, the refetch and the toast.
import { Button } from '@acme/ui/components/button';
import { Card, CardAction, CardHeader, CardTitle } from '@acme/ui/components/card';

export function ApiStatus({
  version,
  refreshing,
  onRefresh,
}: {
  version: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>API version {version}</CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

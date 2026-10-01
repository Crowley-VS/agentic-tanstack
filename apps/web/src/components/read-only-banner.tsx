// Shown on every page while the API rejects writes (READ_ONLY=true); the forms render disabled.
import { Alert, AlertDescription, AlertTitle } from '@acme/ui/components/alert';
import { useReadOnly } from '../lib/app-status';

export function ReadOnlyBanner() {
  if (!useReadOnly()) return null;
  return (
    <Alert>
      <AlertTitle>Read-only mode</AlertTitle>
      <AlertDescription>New notes and comments are turned off for now.</AlertDescription>
    </Alert>
  );
}

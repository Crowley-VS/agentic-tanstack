// What the server renders for the banner, from the app status the root loader cached.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { appStatusOptions } from '../lib/app-status';
import { ReadOnlyBanner } from './read-only-banner';

/** The banner's server markup, with the app status the root loader would have cached. */
function render(readOnly: boolean) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ReadOnlyBanner />
    </QueryClientProvider>,
  );
}

describe('ReadOnlyBanner', () => {
  it('says so while the API is read-only', () => {
    const html = render(true);
    expect(html).toContain('Read-only mode');
    expect(html).toContain('role="alert"');
  });

  it('renders nothing while the API accepts writes', () => {
    expect(render(false)).toBe('');
  });
});

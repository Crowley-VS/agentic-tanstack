// The API card in real Chromium: what the user sees and clicks (the server markup: api-status.test.tsx).
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ApiStatus } from './api-status';

describe('ApiStatus (browser)', () => {
  it('shows the API version, and a click on Refresh calls onRefresh once', async () => {
    const onRefresh = vi.fn();
    const screen = await render(
      <ApiStatus version="v1" refreshing={false} onRefresh={onRefresh} />,
    );

    await expect.element(screen.getByText('API version v1', { exact: true })).toBeVisible();
    const refresh = screen.getByRole('button', { name: 'Refresh', exact: true });
    await expect.element(refresh).toBeEnabled();
    await expect.element(refresh).toHaveAttribute('aria-busy', 'false');

    await refresh.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('disables Refresh and marks it busy while refreshing', async () => {
    const onRefresh = vi.fn();
    const screen = await render(<ApiStatus version="v1" refreshing onRefresh={onRefresh} />);

    const refresh = screen.getByRole('button', { name: 'Refresh', exact: true });
    await expect.element(refresh).toBeDisabled();
    await expect.element(refresh).toHaveAttribute('aria-busy', 'true');
    // a disabled button ignores the click (force: skip Playwright's wait for it to be enabled)
    await refresh.click({ force: true });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

// Browser tests render with the app's real stylesheet (vitest.browser.config.ts), as the app does:
// without it Tailwind classes do nothing, and visibility or state assertions can pass falsely.
import { Button } from '@acme/ui/components/button';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

describe('the app stylesheet in browser tests', () => {
  it('styles components with their Tailwind classes', async () => {
    const screen = await render(<Button disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save', exact: true });
    await expect.element(button).toBeDisabled();
    // Button's `disabled:opacity-50`; '1' when the CSS is missing
    expect(getComputedStyle(button.element()).opacity).toBe('0.5');
  });
});

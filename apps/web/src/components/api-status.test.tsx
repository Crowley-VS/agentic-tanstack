// What the server renders for the API card (clicks and the toast need a browser: Browser Mode).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiStatus } from './api-status';

const render = (refreshing: boolean) =>
  renderToStaticMarkup(<ApiStatus version="v1" refreshing={refreshing} onRefresh={() => {}} />);
/** The opening tag of the Refresh button. */
const refreshButton = (html: string) => html.match(/<button[^>]*>(?=Refresh<)/)?.[0];

describe('ApiStatus', () => {
  it('shows the API version and an enabled Refresh button', () => {
    const html = render(false);
    expect(html).toContain('API version v1');
    expect(refreshButton(html)).toBeDefined();
    expect(refreshButton(html)).not.toMatch(/\sdisabled=/);
    expect(refreshButton(html)).toContain('aria-busy="false"');
  });

  it('disables Refresh and marks it busy while refreshing', () => {
    const button = refreshButton(render(true));
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('aria-busy="true"');
  });
});

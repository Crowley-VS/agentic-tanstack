// What a failed page load renders during SSR (here: Node, so the router is on the server).
import { RouterContextProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLRequestError } from '../lib/graphql/errors';
import { getRouter } from '../router';
import { ErrorPage, errorPageMessage } from './error-page';

const render = (error: Error) =>
  renderToStaticMarkup(
    <RouterContextProvider router={getRouter()}>
      <ErrorPage error={error} />
    </RouterContextProvider>,
  );
const secretDetail = new Error('connect ECONNREFUSED 10.0.0.5:4000 (db password=hunter2)');
const API_DOWN = 'The server is not answering right now. Try again in a moment.';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ErrorPage', () => {
  it("is the router's error page for every route", () => {
    expect(getRouter().options.defaultErrorComponent).toBe(ErrorPage);
  });

  it('logs the error on the server, with its cause', () => {
    render(secretDetail);
    expect(console.error).toHaveBeenCalledWith('[web] SSR: a page failed to load', secretDetail);
  });

  it('never shows the error message in production', () => {
    vi.stubEnv('DEV', false);
    const html = render(secretDetail);
    expect(html).toContain('Something went wrong while loading this page.');
    expect(html).not.toContain('hunter2');
    expect(html).toContain('Try again');
  });

  it('says the server is not answering when the API is down or slow', () => {
    vi.stubEnv('DEV', false);
    const cause = new Error('invalid web environment: API_HOST');
    const unavailable = new GraphQLRequestError(502, [{ message: 'API unavailable' }], { cause });
    expect(render(unavailable)).toContain(API_DOWN);
    expect(render(unavailable)).not.toContain('API_HOST');
    // what the browser gets for an SSR error: a plain Error with the same message
    for (const message of ['API unavailable', 'API timed out'])
      expect(errorPageMessage(new Error(message))).toBe(API_DOWN);
    expect(errorPageMessage(new Error('API unavailable!'))).not.toBe(API_DOWN);
  });

  it('shows the message in development', () => {
    expect(render(secretDetail)).toContain('Something went wrong: connect ECONNREFUSED');
    expect(errorPageMessage(new Error('API timed out'))).toBe(
      'Something went wrong: API timed out',
    );
  });
});

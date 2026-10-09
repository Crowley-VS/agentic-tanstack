// The web server's logger: JSON lines in a production build or runtime (what Railway parses), text
// elsewhere, and error lines tagged with the id of the request being handled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The request Start is handling (getRequest(), its AsyncLocalStorage): none unless a test sets one
const page = vi.hoisted(() => ({ request: undefined as Request | undefined }));
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => {
    if (!page.request) throw new Error('no request: called outside Start');
    return page.request;
  },
  getRequestIP: () => '10.0.0.3',
}));

/** The module afresh: log() reads the environment once, on first use. */
async function fresh() {
  vi.resetModules();
  return import('./log.server');
}
/** Every line written so far, stdout and stderr. */
const written = () =>
  [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map(([line]) =>
    String(line),
  );

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  page.request = undefined;
});

describe('log()', () => {
  it('writes JSON lines in a production build, whatever NODE_ENV says, with the version', async () => {
    vi.stubEnv('PROD', true); // what `vite build` inlines as import.meta.env.PROD
    vi.stubEnv('APP_VERSION', '9f2c1ab');
    (await fresh()).log().error('boom', { requestId: 'r-1' });
    expect(written().map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        level: 'error',
        app: 'web',
        version: '9f2c1ab',
        message: 'boom',
        requestId: 'r-1',
      }),
    ]);
  });

  it('writes text lines elsewhere, unless LOG_FORMAT says otherwise; the version defaults to dev', async () => {
    (await fresh()).log().info('hello');
    vi.stubEnv('LOG_FORMAT', 'json');
    (await fresh()).log().info('hello');
    expect(written()).toEqual(['[web] hello', expect.stringContaining('"version":"dev"')]);
  });
});

describe('logError()', () => {
  it('tags the line with the id of the request being handled, and writes the error', async () => {
    const { logError } = await fresh();
    page.request = new Request('http://web.test/', {
      headers: { 'x-railway-request-id': 'edge-err-1' },
    });
    logError('SSR: a page failed to load', new Error('connect ECONNREFUSED'));
    page.request = undefined;
    logError('outside a request', new Error('x'));
    expect(written()).toEqual([
      expect.stringMatching(/^\[web\] SSR: a page failed to load requestId=edge-err-1\nError: /),
      expect.stringMatching(/^\[web\] outside a request\nError: x/),
    ]);
  });
});

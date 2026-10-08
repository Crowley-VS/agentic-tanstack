// The web server and the API deploy separately: a renamed header or a changed rule must be a
// deliberate change to this pinned contract, not a side effect.
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  CLIENT_IP_HEADER,
  InternalApiSecret,
  REQUEST_ID_HEADER,
  SECRET_HEADER,
  SECRET_REQUIRED_IN_PRODUCTION,
} from './internal-api';

describe('the web → API contract', () => {
  it('pins the header names', () => {
    expect([SECRET_HEADER, CLIENT_IP_HEADER, REQUEST_ID_HEADER]).toEqual([
      'x-internal-secret',
      'x-client-ip',
      'x-request-id',
    ]);
  });

  it('accepts no secret, or one of at least 32 characters', () => {
    expect(InternalApiSecret.safeParse(undefined).success).toBe(true);
    expect(InternalApiSecret.safeParse('s'.repeat(32)).success).toBe(true);
    expect(InternalApiSecret.safeParse('s'.repeat(31)).error?.issues[0]?.message).toBe(
      'INTERNAL_API_SECRET must be at least 32 characters',
    );
  });

  it('names the variable production refuses to run without', () => {
    expect(SECRET_REQUIRED_IN_PRODUCTION).toEqual({
      path: ['INTERNAL_API_SECRET'],
      error: 'INTERNAL_API_SECRET is required in production',
    });
  });

  it('stays as it is when an env schema refines with it (both apps share the object)', () => {
    const before = structuredClone(SECRET_REQUIRED_IN_PRODUCTION);
    z.object({}).refine(() => true, SECRET_REQUIRED_IN_PRODUCTION);
    expect(SECRET_REQUIRED_IN_PRODUCTION).toEqual(before);
  });
});

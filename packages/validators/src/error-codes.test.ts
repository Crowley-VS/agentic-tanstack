// Deployed clients match on these strings: changing one breaks every client not yet redeployed.
import { describe, expect, it } from 'vitest';
import { RATE_LIMITED, READ_ONLY } from './error-codes';

describe('error codes', () => {
  it('pins the codes clients act on', () => {
    expect({ READ_ONLY, RATE_LIMITED }).toEqual({
      READ_ONLY: 'READ_ONLY',
      RATE_LIMITED: 'RATE_LIMITED',
    });
  });
});

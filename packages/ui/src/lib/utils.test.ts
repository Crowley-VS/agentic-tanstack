import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('joins conditional classes and lets the last conflicting Tailwind class win', () => {
    const hidden = false as boolean;
    expect(cn('px-2 py-1', hidden && 'hidden', { 'font-medium': true }, 'px-4')).toBe(
      'py-1 font-medium px-4',
    );
  });
});

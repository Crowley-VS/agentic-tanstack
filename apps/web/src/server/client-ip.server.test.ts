import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip.server';

const headers = (init: Record<string, string>) => new Headers(init);

describe('clientIp', () => {
  it('takes the trusted header when it holds an IP, else the socket address', () => {
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.9' }), '10.0.0.1', 'x-real-ip')).toBe(
      '203.0.113.9',
    );
    expect(clientIp(headers({ 'x-real-ip': ' 2001:db8::1 ' }), '10.0.0.1', 'x-real-ip')).toBe(
      '2001:db8::1',
    );
    expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.9' }), '10.0.0.1', 'x-real-ip')).toBe(
      '10.0.0.1',
    );
    for (const value of ['not-an-ip', '203.0.113.9, 10.0.0.2', ''])
      expect(clientIp(headers({ 'x-real-ip': value }), '10.0.0.1', 'x-real-ip')).toBe('10.0.0.1');
    expect(clientIp(headers({}), undefined, 'x-real-ip')).toBeUndefined();
  });

  it('never reads X-Forwarded-For, nor any header when none is configured', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '192.0.2.1' }), '10.0.0.1', 'x-real-ip')).toBe(
      '10.0.0.1',
    );
    const spoofed = headers({ 'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2' });
    expect(clientIp(spoofed, '10.0.0.1', '')).toBe('10.0.0.1');
  });

  it('unwraps an IPv4 address a dual-stack socket reports in IPv6 form', () => {
    expect(clientIp(headers({}), '::ffff:127.0.0.1', '')).toBe('127.0.0.1');
    expect(clientIp(headers({ 'x-real-ip': '::ffff:203.0.113.9' }), '::1', 'x-real-ip')).toBe(
      '203.0.113.9',
    );
    expect(clientIp(headers({}), '::1', '')).toBe('::1');
    expect(clientIp(headers({}), '::ffff:7f00:1', '')).toBe('::ffff:7f00:1');
  });
});

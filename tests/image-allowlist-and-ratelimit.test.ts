import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSafeCardImageUrl } from '@/lib/image-allowlist';
import { rateLimit } from '@/lib/rate-limit';

describe('image allowlist (SSRF defense) & sliding-window rate limiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks untrusted or SSRF hosts and proxies allowlisted TCG hosts safely', () => {
    expect(resolveSafeCardImageUrl('https://evil.example/card.jpg')).toBeNull();
    expect(resolveSafeCardImageUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(resolveSafeCardImageUrl('javascript:alert(1)')).toBeNull();

    const ygoUrl = 'https://images.ygoprodeck.com/images/cards/89631139.jpg';
    expect(resolveSafeCardImageUrl(ygoUrl)).toBe(
      `https://wsrv.nl/?url=${encodeURIComponent(ygoUrl)}&n=-1`
    );

    const scryfallUrl = 'https://cards.scryfall.io/normal/front/a/b/abc.jpg';
    expect(resolveSafeCardImageUrl(scryfallUrl, { passThroughDirectHosts: true })).toBe(
      scryfallUrl
    );
  });

  it('enforces sliding-window request limits per IP and resets after window expiration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));

    const ip = '203.0.113.77';
    expect(rateLimit(ip, 3, 10_000)).toEqual({ success: true });
    expect(rateLimit(ip, 3, 10_000)).toEqual({ success: true });
    expect(rateLimit(ip, 3, 10_000)).toEqual({ success: true });
    expect(rateLimit(ip, 3, 10_000)).toEqual({ success: false });

    vi.advanceTimersByTime(10_001);
    expect(rateLimit(ip, 3, 10_000)).toEqual({ success: true });
  });
});

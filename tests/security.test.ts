import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://europetcg.eu';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-project.supabase.co';
});

import {
  escapeCsvCell,
  escapeHtml,
  extractPrivateStoragePath,
  getClientIp,
  getTicketAttachmentHref,
  isPdfAttachment,
  isSafeSupabaseStorageUrl,
  resolveTicketAttachmentLocation,
  sanitizeRedirectUrl,
} from '@/lib/security';

describe('security utilities', () => {
  it('blocks open redirects while preserving safe relative and allowlisted origin URLs', () => {
    expect(sanitizeRedirectUrl('/es/user/wallet?tab=deposits')).toBe(
      'https://europetcg.eu/es/user/wallet?tab=deposits'
    );
    expect(sanitizeRedirectUrl('https://europetcg.eu/es/auctions/123')).toBe(
      'https://europetcg.eu/es/auctions/123'
    );
    expect(sanitizeRedirectUrl('https://www.europetcg.eu/en/market')).toBe(
      'https://www.europetcg.eu/en/market'
    );

    // Attack vectors fall back to safe default route
    expect(sanitizeRedirectUrl('https://evil.example/phish')).toBe('https://europetcg.eu/es');
    expect(sanitizeRedirectUrl('//evil.example/phish')).toBe('https://europetcg.eu/es');
    expect(sanitizeRedirectUrl('/\\evil.example')).toBe('https://europetcg.eu/es');
    expect(sanitizeRedirectUrl('javascript:alert(1)', 'en')).toBe('https://europetcg.eu/en');
  });

  it('escapes HTML special characters against stored XSS in transactional emails', () => {
    expect(escapeHtml('<script>alert("xss")</script> & \'test\'')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#039;test&#039;'
    );
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('neutralizes CSV/Excel formula injection payloads', () => {
    expect(escapeCsvCell('=CMD("calc")')).toBe('"\'=CMD(""calc"")"');
    expect(escapeCsvCell('+1+1')).toBe('"\'+1+1"');
    expect(escapeCsvCell('-10')).toBe('"\'-10"');
    expect(escapeCsvCell('@SUM(A1:A2)')).toBe('"\'@SUM(A1:A2)"');
    expect(escapeCsvCell('Blue-Eyes\nWhite Dragon')).toBe('"Blue-Eyes White Dragon"');
  });

  it('validates Supabase public storage URLs and rejects path traversal or foreign hosts', () => {
    expect(
      isSafeSupabaseStorageUrl(
        'https://demo-project.supabase.co/storage/v1/object/public/card-photos/user-1/front.webp',
        'card-photos'
      )
    ).toBe(true);

    expect(
      isSafeSupabaseStorageUrl(
        'https://evil.supabase.co/storage/v1/object/public/card-photos/user-1/front.webp',
        'card-photos'
      )
    ).toBe(false);

    expect(
      isSafeSupabaseStorageUrl(
        'https://demo-project.supabase.co/storage/v1/object/public/card-photos/../secrets/key.txt',
        'card-photos'
      )
    ).toBe(false);
  });

  it('resolves private ticket/dispute storage attachments without leaking arbitrary external URLs', () => {
    const privatePath = 'user-42/ticket-9/evidence.pdf';
    expect(extractPrivateStoragePath(privatePath, 'ticket-attachments')).toBe(privatePath);
    expect(resolveTicketAttachmentLocation(`dispute-evidence/${privatePath}`)).toEqual({
      bucket: 'dispute-evidence',
      objectPath: privatePath,
    });
    expect(getTicketAttachmentHref(privatePath)).toBe(
      '/api/tickets/attachment?path=ticket-attachments%2Fuser-42%2Fticket-9%2Fevidence.pdf'
    );
    expect(getTicketAttachmentHref('https://evil.example/payload.pdf')).toBeNull();
    expect(isPdfAttachment('evidence.PDF?token=123')).toBe(true);
    expect(isPdfAttachment('photo.webp')).toBe(false);
  });

  it('extracts client IP safely from proxy forwarding headers', () => {
    const reqWithXff = new Request('https://europetcg.eu/api/auctions/bid', {
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    });
    expect(getClientIp(reqWithXff)).toBe('203.0.113.10');

    const reqWithRealIp = new Request('https://europetcg.eu/api/auctions/bid', {
      headers: { 'x-real-ip': '198.51.100.4' },
    });
    expect(getClientIp(reqWithRealIp)).toBe('198.51.100.4');
  });
});

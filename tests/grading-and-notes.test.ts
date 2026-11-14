import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {},
}));

import {
  cleanPublicNotes,
  encodeGradingInNotes,
  formatSubgradesCompact,
  getCertVerificationUrl,
  getCompanyMeta,
  getGradingInfo,
} from '@/lib/grading';
import { getCleanPublicNotes, getPrivateNote } from '@/lib/privateNotes';

describe('grading metadata & private seller notes isolation', () => {
  it('resolves certification verification URLs for supported grading authorities', () => {
    expect(getCompanyMeta('bgs').hasSubgrades).toBe(true);
    expect(getCertVerificationUrl('PSA', ' 12345678 ')).toBe(
      'https://www.psacard.com/cert/12345678'
    );
    expect(getCertVerificationUrl('PSA', '   ')).toBeUndefined();
    expect(
      formatSubgradesCompact({ centering: '9.5', corners: '10', edges: '9.5', surface: '9' })
    ).toBe('C: 9.5 · Cr: 10 · E: 9.5 · S: 9');
  });

  it('round-trips grading fallback tags and strips internal tags from buyer-visible notes', () => {
    const encoded = encodeGradingInNotes('Mint pack fresh copy', {
      isGraded: true,
      company: 'BGS',
      score: '9.5 Gem Mint',
      certNumber: '0012345',
      subgrades: { centering: '9.5', corners: '9.5', edges: '10', surface: '9.5' },
    });

    const parsed = getGradingInfo({ notes: encoded });
    expect(parsed.isGraded).toBe(true);
    expect(parsed.company).toBe('BGS');
    expect(parsed.certNumber).toBe('0012345');
    expect(parsed.subgrades).toEqual({
      centering: '9.5',
      corners: '9.5',
      edges: '10',
      surface: '9.5',
    });

    expect(cleanPublicNotes(`${encoded}\n[PRIV: Binder C3]`)).toBe('Mint pack fresh copy');
  });

  it('reveals private inventory notes strictly to the owner and redacts for buyers', () => {
    const listingWithFallbackTag = {
      private_notes: null,
      notes: 'Near Mint\n[PRIV: Shelf B - Folder 4]',
    };

    expect(getPrivateNote(listingWithFallbackTag, true)).toBe('Shelf B - Folder 4');
    expect(getPrivateNote(listingWithFallbackTag, false)).toBeNull();
    expect(getCleanPublicNotes(listingWithFallbackTag.notes)).toBe('Near Mint');
  });
});

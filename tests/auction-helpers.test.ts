import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {},
}));

import { computeReserveStatus, maskAuctionForClient } from '@/lib/auction-helpers';

describe('auction secrecy & masking helpers', () => {
  it('computes reserve status thresholds without disclosing reserve amounts', () => {
    expect(computeReserveStatus(50, null)).toBe('none');
    expect(computeReserveStatus(50, 0)).toBe('none');
    expect(computeReserveStatus(79, 100)).toBe('pending');
    expect(computeReserveStatus(80, 100)).toBe('close');
    expect(computeReserveStatus(99.99, 100)).toBe('close');
    expect(computeReserveStatus(100, 100)).toBe('met');
    expect(computeReserveStatus(140, 100)).toBe('met');
  });

  it('masks secret reserve price and proxy max_bid according to viewer role', () => {
    const auction = {
      id: 'auc-1',
      seller_id: 'seller-1',
      current_bid: 90,
      extra_images: {
        photos: ['https://demo.supabase.co/photo.webp'],
        proxy_leader: { bidder_id: 'buyer-a', max_bid: 250 },
      },
    };

    const secret = {
      auction_id: 'auc-1',
      seller_id: 'seller-1',
      reserve_price: 100,
      proxy_leader: { bidder_id: 'buyer-a', max_bid: 250 },
    };

    // 1. Seller sees numeric reserve_price, but NOT buyer A's secret proxy ceiling
    const forSeller = maskAuctionForClient(auction, secret, 'seller-1', true);
    expect(forSeller.reserve_price).toBe(100);
    expect(forSeller.reserve_status).toBe('close');
    expect(forSeller.extra_images.proxy_leader).toEqual({
      active: true,
      bidder_id: 'buyer-a',
    });

    // 2. Active proxy leader sees their own max_bid, while reserve remains opaque boolean
    const forProxyLeader = maskAuctionForClient(auction, secret, 'buyer-a', true);
    expect(forProxyLeader.reserve_price).toBe(true);
    expect(forProxyLeader.extra_images.proxy_leader).toEqual({
      active: true,
      bidder_id: 'buyer-a',
      max_bid: 250,
    });

    // 3. Competing bidder sees only whether a reserve/proxy exists, never secret ceilings
    const forCompetitor = maskAuctionForClient(auction, secret, 'buyer-b', true);
    expect(forCompetitor.reserve_price).toBe(true);
    expect(forCompetitor.extra_images.proxy_leader).toEqual({
      active: true,
      bidder_id: 'buyer-a',
    });

    // 4. Public feed strips proxy metadata completely
    const forPublicFeed = maskAuctionForClient(auction, secret, null, false);
    expect(forPublicFeed.reserve_price).toBe(true);
    expect(forPublicFeed.extra_images.proxy_leader).toBeNull();
  });
});

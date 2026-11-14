import { describe, expect, it } from 'vitest';
import {
  calculateSellerMultiItemDiscount,
  normalizeBundleDiscountTiers,
} from '@/lib/bundleDiscounts';

describe('seller bundle discount engine', () => {
  it('normalizes discount tiers and caps each tier at 50% safety bound', () => {
    expect(normalizeBundleDiscountTiers({ tier2: 5, tier3: 80, tier5: -4 })).toEqual({
      tier2: 5,
      tier3: 50,
    });

    expect(normalizeBundleDiscountTiers({ '2': 10, '5': 20 })).toEqual({
      tier2: 10,
      tier5: 20,
    });

    expect(normalizeBundleDiscountTiers(null)).toEqual({});
  });

  it('applies highest qualified tier only to eligible single cards (excluding auctions & bundles)', () => {
    const result = calculateSellerMultiItemDiscount(
      [
        { id: '1', price: 10, quantity: 2, set_code: 'LOB' },
        { id: '2', price: 20, quantity: 1, set_code: 'MRD' },
        // Auctions and pre-packaged lots must NOT stack multi-item discounts
        { id: 'auction_99', price: 100, quantity: 1, set_code: 'SUBASTA' },
        { id: '3', price: 40, quantity: 1, is_bundle: true, set_code: 'LOTE' },
      ],
      { tier2: 5, tier3: 10, tier5: 15 }
    );

    expect(result.eligibleQty).toBe(3);
    expect(result.eligibleSubtotal).toBe(40); // 2*10 + 1*20
    expect(result.appliedTier).toBe(3);
    expect(result.discountPercent).toBe(10);
    expect(result.discountAmount).toBe(4);
    expect(result.nextTier).toEqual({
      threshold: 5,
      percent: 15,
      missingQty: 2,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  calculatePlatformFee,
  getSellerCommissionInfo,
  MAX_COMMISSION_FEE_CAP_EUR,
  PRO_POWERSELLER_COMMISSION_RATE,
  PRO_STANDARD_COMMISSION_RATE,
  STANDARD_COMMISSION_RATE,
} from '@/lib/commission';

describe('marketplace commission engine', () => {
  it('calculates rounded platform fees and enforces the €50 per-item fee cap', () => {
    expect(calculatePlatformFee(100, STANDARD_COMMISSION_RATE)).toBe(3.5);
    expect(calculatePlatformFee(19.99, STANDARD_COMMISSION_RATE)).toBe(0.7);
    expect(calculatePlatformFee(5000, STANDARD_COMMISSION_RATE)).toBe(MAX_COMMISSION_FEE_CAP_EUR);
    expect(calculatePlatformFee(-20, STANDARD_COMMISSION_RATE)).toBe(0);
  });

  it('resolves seller tiers cleanly: standard, authorized pro promo, pro post-promo, and powerseller', () => {
    const standardInfo = getSellerCommissionInfo({ account_type: 'personal' });
    expect(standardInfo.tier).toBe('standard');
    expect(standardInfo.rate).toBe(STANDARD_COMMISSION_RATE);
    expect(standardInfo.percentLabel).toBe('3.5%');

    const proPromoInfo = getSellerCommissionInfo({
      is_authorized_seller: true,
      account_type: 'business',
      sales_completed: 12,
    });
    expect(proPromoInfo.tier).toBe('pro');
    expect(proPromoInfo.isPromoZeroFee).toBe(true);
    expect(proPromoInfo.rate).toBe(0);
    expect(proPromoInfo.promoSalesLeft).toBe(38);

    const proStandardInfo = getSellerCommissionInfo({
      is_authorized_seller: true,
      account_type: 'pro',
      sales_completed: 60,
    });
    expect(proStandardInfo.tier).toBe('pro');
    expect(proStandardInfo.isPromoZeroFee).toBe(false);
    expect(proStandardInfo.rate).toBe(PRO_STANDARD_COMMISSION_RATE);

    const powersellerInfo = getSellerCommissionInfo({
      is_authorized_seller: true,
      is_powerseller: true,
      account_type: 'pro',
      sales_completed: 60,
    });
    expect(powersellerInfo.tier).toBe('powerseller');
    expect(powersellerInfo.isPowerseller).toBe(true);
    expect(powersellerInfo.rate).toBe(PRO_POWERSELLER_COMMISSION_RATE);
  });
});

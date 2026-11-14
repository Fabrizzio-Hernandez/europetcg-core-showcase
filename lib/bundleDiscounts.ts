export type BundleDiscountTiers = {
  tier2?: number;
  tier3?: number;
  tier5?: number;
};

export interface BundleDiscountResult {
  eligibleQty: number;
  eligibleSubtotal: number;
  appliedTier: number | null;
  discountPercent: number;
  discountAmount: number;
  nextTier: { threshold: number; percent: number; missingQty: number } | null;
}

/**
 * Normaliza y valida los niveles de descuento por lote/carrito multi-artículo (estilo Vinted).
 * Cada porcentaje queda acotado entre 0% y 50% por seguridad.
 */
export function normalizeBundleDiscountTiers(raw: any): BundleDiscountTiers {
  if (!raw || typeof raw !== 'object') return {};
  const clampPct = (v: any) => {
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? Math.min(50, n) : 0;
  };
  const tier2 = clampPct(raw.tier2 ?? raw['2']);
  const tier3 = clampPct(raw.tier3 ?? raw['3']);
  const tier5 = clampPct(raw.tier5 ?? raw['5']);
  const out: BundleDiscountTiers = {};
  if (tier2 > 0) out.tier2 = tier2;
  if (tier3 > 0) out.tier3 = tier3;
  if (tier5 > 0) out.tier5 = tier5;
  return out;
}

/**
 * Calcula el descuento progresivo automático para los artículos estándar (cartas/anuncios individuales)
 * de un mismo vendedor dentro del carrito. Excluye subastas y lotes ya cerrados.
 */
export function calculateSellerMultiItemDiscount(
  items: Array<{
    price: number;
    verified_price?: number;
    quantity: number;
    set_code?: string;
    is_bundle?: boolean;
    listing_id?: string | number;
    id?: string | number;
  }>,
  rawTiers: any
): BundleDiscountResult {
  const tiers = normalizeBundleDiscountTiers(rawTiers);
  const candidates: Array<{ threshold: number; percent: number }> = [];
  if (tiers.tier2) candidates.push({ threshold: 2, percent: tiers.tier2 });
  if (tiers.tier3) candidates.push({ threshold: 3, percent: tiers.tier3 });
  if (tiers.tier5) candidates.push({ threshold: 5, percent: tiers.tier5 });
  candidates.sort((a, b) => a.threshold - b.threshold);

  let eligibleQty = 0;
  let eligibleSubtotal = 0;

  for (const item of items) {
    const qty = Math.max(0, Math.floor(Number(item.quantity) || 0));
    if (qty <= 0) continue;
    const idStr = String(item.listing_id ?? item.id ?? '');
    const setUpper = String(item.set_code || '').toUpperCase();
    const isAuction = setUpper === 'SUBASTA' || idStr.startsWith('auction_');
    const isBundle =
      Boolean(item.is_bundle) ||
      setUpper === 'LOTE' ||
      idStr.startsWith('bundle_') ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idStr);

    if (isAuction || isBundle) continue;

    const unitPrice = Number(item.verified_price ?? item.price ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

    eligibleQty += qty;
    eligibleSubtotal += unitPrice * qty;
  }

  eligibleSubtotal = Math.round(eligibleSubtotal * 100) / 100;

  let appliedTier: number | null = null;
  let discountPercent = 0;
  let nextTier: { threshold: number; percent: number; missingQty: number } | null = null;

  for (const c of candidates) {
    if (eligibleQty >= c.threshold) {
      appliedTier = c.threshold;
      discountPercent = c.percent;
    } else if (!nextTier) {
      nextTier = {
        threshold: c.threshold,
        percent: c.percent,
        missingQty: c.threshold - eligibleQty,
      };
    }
  }

  const discountAmount =
    discountPercent > 0
      ? Math.round(eligibleSubtotal * (discountPercent / 100) * 100) / 100
      : 0;

  return {
    eligibleQty,
    eligibleSubtotal,
    appliedTier,
    discountPercent,
    discountAmount,
    nextTier,
  };
}

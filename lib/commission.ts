/**
 * Lógica centralizada de comisiones de EuropeTCG
 *
 * 1. Vendedor Estándar (Particular / Coleccionista):
 *    • 3.5% en todas las ventas (Envío Postal o Taquilla InPost / Mondial Relay).
 *    • Retención neta: 96.5%.
 *
 * 2. Tienda PRO (Profesional / Verificada):
 *    • Primeras 50 ventas completadas: 0% de comisión (100% íntegro para la tienda).
 *    • A partir de la venta 51: 2.5% de comisión (97.5% neto para la tienda).
 *
 * 3. Tienda Powerseller Élite (Top Sellers por Volumen y Calidad):
 *    • Primeras 50 ventas: 0% de comisión promocional de bienvenida.
 *    • Tarifa permanente por volumen: 1.5% de comisión (98.5% neto para la tienda).
 *    • Insignia dorada exclusiva, liquidaciones bancarias SEPA en el mismo día y herramientas masivas CSV gratuitas.
 */

export const STANDARD_COMMISSION_RATE = 0.035; // 3.5%
export const PRO_STANDARD_COMMISSION_RATE = 0.025; // 2.5%
export const PRO_POWERSELLER_COMMISSION_RATE = 0.015; // 1.5%
export const PRO_PROMO_COMMISSION_RATE = 0.0; // 0.0%
export const PRO_PROMO_FREE_SALES_LIMIT = 50; // Primeras 50 ventas completadas al 0%
export const PRO_PROMO_DURATION_DAYS = 180; // Referencia histórica / compatibilidad
export const PRO_PROMO_DURATION_MS = PRO_PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_COMMISSION_FEE_CAP_EUR = 50.00; // Tope máximo de comisión por artículo (Estándar Cardmarket)

/**
 * Calcula la comisión de intermediación aplicando el tope máximo de protección (Fee Cap)
 * Estándar Cardmarket: evita sangrar a los coleccionistas en cartas de muy alto valor (Power 9, PSA 10, etc.)
 */
export function calculatePlatformFee(productValue: number, commissionRate: number): number {
  if (commissionRate <= 0 || productValue <= 0) return 0;
  const rawFee = Math.round(productValue * commissionRate * 100) / 100;
  return Math.min(rawFee, MAX_COMMISSION_FEE_CAP_EUR);
}

export const POWERSELLER_CRITERIA = {
  MIN_MONTHLY_VOLUME_EUR: 3000, // Facturación mínima 3.000 € – 5.000 € / mes
  MIN_COMPLETED_ORDERS: 100, // O más de 100 pedidos/ventas completadas
  MIN_ACTIVE_CATALOG_ITEMS: 1000, // Al menos 1.000 referencias activas en inventario
  MIN_POSITIVE_FEEDBACK_PERCENT: 98, // ≥ 98% valoraciones positivas
  MAX_DISPATCH_HOURS: 48, // Despacho medio ≤ 48h laborables
  MAX_DISPUTE_RATE_PERCENT: 1.0, // Tasa de incidencias < 1%
} as const;

export interface SellerProfileForCommission {
  id?: string | null;
  username?: string | null;
  user_type?: string | null;
  account_type?: string | null;
  seller_tier?: 'standard' | 'pro' | 'powerseller' | string | null;
  is_authorized_seller?: boolean | null;
  is_powerseller?: boolean | null;
  member_since?: string | Date | null;
  created_at?: string | Date | null;
  promo_zero_fee_until?: string | Date | null;
  sales_completed?: number | null;
  sales_count?: number | null;
  positive_evals?: number | null;
  rating?: number | null;
}

export type SellerTier = 'standard' | 'pro' | 'powerseller';

export interface SellerCommissionInfo {
  rate: number;
  percentLabel: string;
  netPercentLabel: string;
  tier: SellerTier;
  isPro: boolean;
  isPowerseller: boolean;
  isPromoZeroFee: boolean;
  promoSalesLeft: number;
  promoDaysLeft: number; // Mantenido como alias de promoSalesLeft por retrocompatibilidad
  promoEndsAt: Date | null;
}

export function isProSellerProfile(profile?: SellerProfileForCommission | null): boolean {
  if (!profile) return false;
  return (
    profile.user_type === 'professional' ||
    profile.account_type === 'business' ||
    profile.account_type === 'pro' ||
    profile.account_type === 'powerseller' ||
    profile.seller_tier === 'powerseller' ||
    profile.is_powerseller === true
  );
}

export function isPowersellerProfile(profile?: SellerProfileForCommission | null): boolean {
  if (!profile) return false;

  // Asignación 100% manual y exclusiva por decisión del Administrador
  // Nadie asciende a Powerseller de forma automática
  if (
    profile.is_powerseller === true ||
    profile.account_type === 'powerseller' ||
    profile.seller_tier === 'powerseller'
  ) {
    return true;
  }

  return false;
}

export function getSellerCommissionInfo(
  profile?: SellerProfileForCommission | null,
  referenceDate: Date = new Date()
): SellerCommissionInfo {
  const isPro = isProSellerProfile(profile);
  const isPowerseller = isPowersellerProfile(profile);

  if (!isPro && !isPowerseller) {
    return {
      rate: STANDARD_COMMISSION_RATE,
      percentLabel: '3.5%',
      netPercentLabel: '96.5%',
      tier: 'standard',
      isPro: false,
      isPowerseller: false,
      isPromoZeroFee: false,
      promoSalesLeft: 0,
      promoDaysLeft: 0,
      promoEndsAt: null,
    };
  }

  // Comprobación de ventas acumuladas para la promoción de 50 ventas al 0%
  const completedSales = Math.max(
    Number(profile?.sales_completed || 0),
    Number(profile?.sales_count || 0)
  );

  const isPromoZeroFee = Boolean(isPro && completedSales < PRO_PROMO_FREE_SALES_LIMIT);
  const promoSalesLeft = isPro ? Math.max(0, PRO_PROMO_FREE_SALES_LIMIT - completedSales) : 0;

  if (isPromoZeroFee) {
    return {
      rate: PRO_PROMO_COMMISSION_RATE,
      percentLabel: '0%',
      netPercentLabel: '100%',
      tier: isPowerseller ? 'powerseller' : 'pro',
      isPro: true,
      isPowerseller,
      isPromoZeroFee: true,
      promoSalesLeft,
      promoDaysLeft: promoSalesLeft, // Alias para componentes antiguos
      promoEndsAt: null,
    };
  }

  // Tienda Powerseller Élite fuera de la promo de bienvenida de 50 ventas: 1.5% permanente por volumen
  if (isPowerseller) {
    return {
      rate: PRO_POWERSELLER_COMMISSION_RATE,
      percentLabel: '1.5%',
      netPercentLabel: '98.5%',
      tier: 'powerseller',
      isPro: true,
      isPowerseller: true,
      isPromoZeroFee: false,
      promoSalesLeft: 0,
      promoDaysLeft: 0,
      promoEndsAt: null,
    };
  }

  // Tienda PRO Estándar fuera de la promo de bienvenida de 50 ventas: 2.5%
  return {
    rate: PRO_STANDARD_COMMISSION_RATE,
    percentLabel: '2.5%',
    netPercentLabel: '97.5%',
    tier: 'pro',
    isPro: true,
    isPowerseller: false,
    isPromoZeroFee: false,
    promoSalesLeft: 0,
    promoDaysLeft: 0,
    promoEndsAt: null,
  };
}

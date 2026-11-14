import { supabaseAdmin } from '@/lib/supabase-admin'

export interface ProxyLeaderSecret {
  bidder_id: string
  max_bid: number
}

export interface AuctionSecretRecord {
  auction_id: string
  seller_id: string
  reserve_price: number | null
  proxy_leader: ProxyLeaderSecret | null
}

/**
 * Fetches secret auction data (reserve_price, proxy_leader) for a single auction via service role.
 */
export async function getAuctionSecret(auctionId: string): Promise<AuctionSecretRecord | null> {
  const { data } = await supabaseAdmin
    .from('auction_secrets')
    .select('auction_id, seller_id, reserve_price, proxy_leader')
    .eq('auction_id', auctionId)
    .maybeSingle()

  return (data as AuctionSecretRecord | null) || null
}

/**
 * Batch fetches secret auction records indexed by auction_id.
 */
export async function getAuctionSecretsMap(
  auctionIds: string[]
): Promise<Map<string, AuctionSecretRecord>> {
  const map = new Map<string, AuctionSecretRecord>()
  if (!auctionIds || auctionIds.length === 0) return map

  const uniqueIds = Array.from(new Set(auctionIds.filter(Boolean)))
  if (uniqueIds.length === 0) return map

  const { data } = await supabaseAdmin
    .from('auction_secrets')
    .select('auction_id, seller_id, reserve_price, proxy_leader')
    .in('auction_id', uniqueIds)

  for (const row of (data || []) as AuctionSecretRecord[]) {
    map.set(row.auction_id, row)
  }
  return map
}

export function computeReserveStatus(
  currentBid: number | string,
  secretReservePrice: number | string | null | undefined
): 'none' | 'met' | 'close' | 'pending' {
  const reserve = secretReservePrice ? Number(secretReservePrice) : 0
  if (!Number.isFinite(reserve) || reserve <= 0) return 'none'
  const bid = Number(currentBid || 0)
  if (bid >= reserve) return 'met'
  if (bid >= reserve * 0.8) return 'close'
  return 'pending'
}

/**
 * Shapes an auction row for client responses, keeping reserve_price visible only to the seller
 * and proxy_leader.max_bid visible only to the active proxy leader.
 */
export function maskAuctionForClient(
  auctionObj: Record<string, any>,
  secret: AuctionSecretRecord | null | undefined,
  currentUserId?: string | null,
  includeProxyInfo = true
) {
  if (!auctionObj) return auctionObj

  const effectiveReserve = secret?.reserve_price ?? auctionObj.reserve_price ?? null
  const hasReserve = Boolean(effectiveReserve && Number(effectiveReserve) > 0)
  const reserveStatus = computeReserveStatus(auctionObj.current_bid, effectiveReserve)
  const isSeller = Boolean(currentUserId && auctionObj.seller_id === currentUserId)

  const proxyLeader =
    secret?.proxy_leader ??
    (auctionObj.extra_images &&
    typeof auctionObj.extra_images === 'object' &&
    !Array.isArray(auctionObj.extra_images)
      ? auctionObj.extra_images.proxy_leader
      : null)

  let cleanExtra = auctionObj.extra_images
  if (cleanExtra && typeof cleanExtra === 'object' && !Array.isArray(cleanExtra)) {
    const restExtra = { ...cleanExtra }
    delete restExtra.proxy_leader

    if (includeProxyInfo && proxyLeader) {
      const isProxyOwner = Boolean(currentUserId && proxyLeader.bidder_id === currentUserId)
      restExtra.proxy_leader = {
        active: true,
        bidder_id: proxyLeader.bidder_id,
        ...(isProxyOwner ? { max_bid: proxyLeader.max_bid } : {}),
      }
    } else {
      restExtra.proxy_leader = null
    }
    cleanExtra = restExtra
  }

  return {
    ...auctionObj,
    reserve_price: isSeller ? (effectiveReserve !== null ? Number(effectiveReserve) : null) : hasReserve ? true : null,
    reserve_status: reserveStatus,
    extra_images: cleanExtra,
  }
}

/**
 * Safely persists or clears proxy_leader inside auction_secrets without altering reserve_price.
 */
export async function saveAuctionProxyLeader(
  auctionId: string,
  sellerId: string,
  existingSecret: AuctionSecretRecord | null,
  proxyLeader: ProxyLeaderSecret | null
): Promise<AuctionSecretRecord | null> {
  const nowIso = new Date().toISOString()

  if (existingSecret) {
    const { data } = await supabaseAdmin
      .from('auction_secrets')
      .update({
        proxy_leader: proxyLeader,
        updated_at: nowIso,
      })
      .eq('auction_id', auctionId)
      .select('auction_id, seller_id, reserve_price, proxy_leader')
      .single()

    return (data as AuctionSecretRecord | null) || {
      ...existingSecret,
      proxy_leader: proxyLeader,
    }
  }

  if (!proxyLeader) {
    return null
  }

  const { data, error } = await supabaseAdmin
    .from('auction_secrets')
    .insert({
      auction_id: auctionId,
      seller_id: sellerId,
      proxy_leader: proxyLeader,
      updated_at: nowIso,
    })
    .select('auction_id, seller_id, reserve_price, proxy_leader')
    .single()

  if (error) {
    // Handle concurrent creation cleanly without overwriting reserve_price
    const { data: updated } = await supabaseAdmin
      .from('auction_secrets')
      .update({
        proxy_leader: proxyLeader,
        updated_at: nowIso,
      })
      .eq('auction_id', auctionId)
      .select('auction_id, seller_id, reserve_price, proxy_leader')
      .maybeSingle()

    return (updated as AuctionSecretRecord | null) || null
  }

  return (data as AuctionSecretRecord | null) || null
}

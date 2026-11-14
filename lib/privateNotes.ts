import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Helper utilities for private seller inventory notes (e.g. storage location: "Box A-12, Binder 3").
 * Strictly isolated in listing_private_notes with owner-only RLS and hidden from buyers/public.
 */

export const LISTING_PUBLIC_COLUMNS =
  'id, card_id, card_name, name, condition, created_at, game, grading_cert_number, grading_company, grading_score, has_real_photo, is_active, is_altered, is_first_edition, is_foil, is_graded, is_overframe, is_playset, is_presale, is_sealed, is_signed, language, notes, photo_url, price, rarity, real_photo_url, seller_id, seller_name, set_code, sold_at, stock'

const PRIV_TAG_REGEX = /\[(?:PRIV|PRIVATE):\s*([\s\S]*?)\s*\]/
const PRIV_TAG_GLOBAL_REGEX = /\[(?:PRIV|PRIVATE):\s*[\s\S]*?\s*\]/g

/**
 * Extracts the private note for a listing.
 * Returns null if the current user is NOT the owner of the listing.
 */
export function getPrivateNote(listing: any, isOwner: boolean): string | null {
  if (!isOwner || !listing) return null

  if (listing.private_notes && typeof listing.private_notes === 'string' && listing.private_notes.trim()) {
    return listing.private_notes.trim()
  }

  if (listing.notes && typeof listing.notes === 'string') {
    const match = listing.notes.match(PRIV_TAG_REGEX)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  return null
}

/**
 * Strips any internal private note tags from public notes so buyers NEVER see them.
 */
export function getCleanPublicNotes(notes: string | null | undefined): string {
  if (!notes) return ''
  return notes.replace(PRIV_TAG_GLOBAL_REGEX, '').trim()
}

/**
 * Keeps only clean public notes — private notes are never encoded into public columns.
 */
export function encodeNotesWithFallback(
  publicNotes: string | null | undefined,
  _privateNotes?: string | null | undefined
): string {
  return getCleanPublicNotes(publicNotes)
}

/**
 * Loads owner-only private notes from `listing_private_notes` indexed by listing_id.
 */
export async function fetchOwnerPrivateNotesMap(
  supabase: SupabaseClient,
  sellerId: string | null | undefined,
  listingIds: Array<number | string>
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!sellerId || !listingIds || listingIds.length === 0) return map

  const numericIds = Array.from(
    new Set(listingIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))
  )
  if (numericIds.length === 0) return map

  const { data } = await supabase
    .from('listing_private_notes')
    .select('listing_id, note')
    .eq('seller_id', sellerId)
    .in('listing_id', numericIds)

  for (const row of data || []) {
    if (row.note) {
      map.set(Number(row.listing_id), row.note)
    }
  }
  return map
}

/**
 * Upserts or clears private notes for owner listings inside `listing_private_notes`.
 */
export async function saveListingPrivateNotes(
  supabase: SupabaseClient,
  sellerId: string,
  entries: Array<{ listingId: number; note: string | null | undefined }>
): Promise<void> {
  if (!sellerId || entries.length === 0) return

  const toUpsert: Array<{ listing_id: number; seller_id: string; note: string; updated_at: string }> = []
  const toDeleteIds: number[] = []
  const nowIso = new Date().toISOString()

  for (const entry of entries) {
    const clean = entry.note?.trim() || ''
    if (clean) {
      toUpsert.push({
        listing_id: entry.listingId,
        seller_id: sellerId,
        note: clean,
        updated_at: nowIso,
      })
    } else {
      toDeleteIds.push(entry.listingId)
    }
  }

  if (toUpsert.length > 0) {
    await supabase
      .from('listing_private_notes')
      .upsert(toUpsert, { onConflict: 'listing_id' })
  }

  if (toDeleteIds.length > 0) {
    await supabase
      .from('listing_private_notes')
      .delete()
      .eq('seller_id', sellerId)
      .in('listing_id', toDeleteIds)
  }
}

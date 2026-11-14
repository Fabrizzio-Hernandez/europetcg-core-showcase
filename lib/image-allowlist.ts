export const ALLOWED_IMAGE_DOMAINS = [
  'tcgplayer-cdn.tcgplayer.com',
  'product-images.tcgplayer.com',
  'tcgplayer.com',
  'cards.scryfall.io',
  'scryfall.io',
  'api.scryfall.com',
  'images.ygoprodeck.com',
  'ygoprodeck.com',
  'assets.tcgdex.net',
  'tcgdex.net',
  'optcgapi.com',
  'api.optcg.gg',
  'optcg.gg',
  'onepiece-cardgame.com',
  'api.swu-db.com',
  'swu-db.com',
  'starwarsunlimited.com',
  'images.digimoncard.io',
  'digimoncard.io',
  'digimoncard.dev',
  'limitlesstcg.com',
  'limitlesstcg.s3.amazonaws.com',
  'pokemontcg.io',
  'api.pokemontcg.io',
  'supabase.co',
  'supabase.in',
  'magic.wizards.com',
  'gatcg.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'fleshandbloodtcg.com',
  'lorcast.io',
  'lorcana-api.com',
  'api.lorcana-api.com',
  'ravensburger.com',
  'scrydex.com',
  'api.scrydex.com',
  'wsrv.nl',
  'yugioh-card.com',
  'img.yugioh-card.com',
  'ddragon.leagueoflegends.com',
] as const

const DIRECT_CDN_DOMAINS = [
  'supabase.co',
  'supabase.in',
  'wsrv.nl',
  'cards.scryfall.io',
  'assets.tcgdex.net',
] as const

function matchesDomainList(hostname: string, domains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase()
  return domains.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  )
}

/**
 * Validates external image URLs against SSRF/non-HTTP schemes and returns either
 * a direct CDN URL or a wsrv.nl cached URL. Returns null if disallowed.
 */
export function resolveSafeCardImageUrl(
  rawUrl: string,
  options: { passThroughDirectHosts?: boolean } = {}
): string | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null
    }
    if (!matchesDomainList(parsed.hostname, ALLOWED_IMAGE_DOMAINS)) {
      return null
    }

    const normalizedHost = parsed.hostname.toLowerCase()
    const shouldPassThrough = options.passThroughDirectHosts
      ? matchesDomainList(normalizedHost, DIRECT_CDN_DOMAINS)
      : normalizedHost === 'wsrv.nl'

    return shouldPassThrough
      ? rawUrl
      : `https://wsrv.nl/?url=${encodeURIComponent(rawUrl)}&n=-1`
  } catch {
    return null
  }
}

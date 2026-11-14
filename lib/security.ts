const DEFAULT_SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://europetcg.eu'
)
  .trim()
  .replace(/\/+$/, '')

const SUPABASE_ORIGIN = (() => {
  try {
    return process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : ''
  } catch {
    return ''
  }
})()

export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>([
    'https://europetcg.eu',
    'https://www.europetcg.eu',
  ])

  try {
    origins.add(new URL(DEFAULT_SITE_URL).origin)
  } catch {}

  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL.replace(/^https?:\/\//, '')}`)
  }
  if (process.env.VERCEL_BRANCH_URL) {
    origins.add(`https://${process.env.VERCEL_BRANCH_URL.replace(/^https?:\/\//, '')}`)
  }
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000')
    origins.add('http://127.0.0.1:3000')
  }

  return origins
}

/**
 * Validates a redirect / return URL against our own site origins (preventing Open Redirects).
 * Rejects protocol-relative URLs (//evil.com), non-HTTP(S) schemes, and foreign domains.
 */
export function sanitizeRedirectUrl(
  rawUrl: string | null | undefined,
  defaultPath = '/es'
): string {
  const safeBase = DEFAULT_SITE_URL
  const fallbackPath = defaultPath.startsWith('/') ? defaultPath : `/${defaultPath}`
  const fallback = `${safeBase}${fallbackPath}`

  if (!rawUrl || typeof rawUrl !== 'string') return fallback
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.startsWith('//') || trimmed.includes('\\')) return fallback

  try {
    const allowedOrigins = getAllowedOrigins()
    // Allow relative app paths (/es/user/wallet)
    if (trimmed.startsWith('/')) {
      const resolved = new URL(trimmed, safeBase)
      if (!allowedOrigins.has(resolved.origin)) return fallback
      return resolved.toString()
    }

    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fallback
    if (!allowedOrigins.has(parsed.origin)) return fallback
    return parsed.toString()
  } catch {
    return fallback
  }
}

/**
 * Verifies a URL points strictly to the expected public Supabase Storage bucket.
 */
export function isSafeSupabaseStorageUrl(
  rawUrl: string | null | undefined,
  bucketName = 'card-photos'
): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0 || trimmed.length > 1000) return false
  if (!SUPABASE_ORIGIN) return false

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' || parsed.origin !== SUPABASE_ORIGIN) {
      return false
    }
    const expectedPrefix = `/storage/v1/object/public/${bucketName}/`
    return parsed.pathname.startsWith(expectedPrefix) && !parsed.pathname.includes('..')
  } catch {
    return false
  }
}

/**
 * Extracts a clean relative storage path for a private bucket, rejecting external URLs and traversal.
 */
export function extractPrivateStoragePath(
  rawValue: string | null | undefined,
  bucketName: string
): string | null {
  if (!rawValue || typeof rawValue !== 'string') return null
  let clean = rawValue.trim()
  if (!clean) return null

  const marker = `/${bucketName}/`
  const prefix = `${bucketName}/`

  if (clean.includes(marker)) {
    try {
      clean = decodeURIComponent(clean.split(marker)[1].split('?')[0])
    } catch {
      return null
    }
  } else if (clean.startsWith(prefix)) {
    clean = clean.slice(prefix.length).split('?')[0]
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) {
    return null
  }

  clean = clean.replace(/^\/+/, '').trim()
  if (!clean || clean.includes('..') || clean.includes('\\')) return null
  return clean
}

export const PRIVATE_TICKET_BUCKETS = [
  'ticket-attachments',
  'dispute-evidence',
  'tickets',
  'kyc-documents',
] as const

export type PrivateTicketBucket = (typeof PRIVATE_TICKET_BUCKETS)[number]

/**
 * Resolves a stored ticket/dispute attachment reference into a validated private bucket and relative path.
 */
export function resolveTicketAttachmentLocation(
  rawValue: string | null | undefined
): { bucket: PrivateTicketBucket; objectPath: string } | null {
  if (!rawValue || typeof rawValue !== 'string') return null
  const trimmed = rawValue.trim()
  if (!trimmed || trimmed.length > 1000) return null

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (!SUPABASE_ORIGIN || parsed.origin !== SUPABASE_ORIGIN) return null
    } catch {
      return null
    }
  }

  for (const bucket of PRIVATE_TICKET_BUCKETS) {
    if (trimmed.includes(`/${bucket}/`) || trimmed.startsWith(`${bucket}/`)) {
      const objectPath = extractPrivateStoragePath(trimmed, bucket)
      if (!objectPath) return null
      return { bucket, objectPath }
    }
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }

  const fallbackPath = extractPrivateStoragePath(trimmed, 'ticket-attachments')
  if (!fallbackPath) return null
  return { bucket: 'ticket-attachments', objectPath: fallbackPath }
}

/**
 * Converts a stored attachment value into an authenticated app URL or validated public card-photos URL.
 */
export function getTicketAttachmentHref(
  rawValue: string | null | undefined
): string | null {
  if (!rawValue || typeof rawValue !== 'string') return null
  const location = resolveTicketAttachmentLocation(rawValue)
  if (location) {
    return `/api/tickets/attachment?path=${encodeURIComponent(
      `${location.bucket}/${location.objectPath}`
    )}`
  }
  if (isSafeSupabaseStorageUrl(rawValue, 'card-photos')) {
    return rawValue.trim()
  }
  return null
}

export function isPdfAttachment(rawValue: string | null | undefined): boolean {
  if (!rawValue || typeof rawValue !== 'string') return false
  const clean = rawValue.split('?')[0].trim().toLowerCase()
  return clean.endsWith('.pdf')
}

export function escapeHtml(str: string | number | null | undefined): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Escapes CSV cell values and neutralizes Excel/Sheets formula injection (=, +, -, @, tab, CR).
 */
export function escapeCsvCell(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '""'
  let str = String(val).replace(/\r?\n/g, ' ')
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`
  }
  return `"${str.replace(/"/g, '""')}"`
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim() || 'unknown'
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

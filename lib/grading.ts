export interface CardSubgrades {
  centering?: string;
  corners?: string;
  edges?: string;
  surface?: string;
}

export interface CardGrading {
  isGraded: boolean;
  company: string;
  score: string;
  certNumber: string;
  certUrl?: string;
  subgrades?: CardSubgrades;
}

export const GRADING_COMPANIES = [
  { 
    id: 'PSA', 
    name: 'PSA (Professional Sports Authenticator)', 
    shortName: 'PSA',
    badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    pillClass: 'bg-red-600 text-white shadow-sm',
    accentHex: '#e11d48',
    hasSubgrades: false,
    lookupUrl: (cert: string) => `https://www.psacard.com/cert/${encodeURIComponent(cert.trim())}`
  },
  { 
    id: 'BGS', 
    name: 'Beckett (BGS)', 
    shortName: 'BGS',
    badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    pillClass: 'bg-gradient-to-r from-amber-600 to-yellow-500 text-slate-950 font-black shadow-sm',
    accentHex: '#d97706',
    hasSubgrades: true,
    lookupUrl: (cert: string) => `https://www.beckett.com/grading/cert-lookup?cert_number=${encodeURIComponent(cert.trim())}`
  },
  { 
    id: 'CGC', 
    name: 'CGC Cards', 
    shortName: 'CGC',
    badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    pillClass: 'bg-blue-600 text-white shadow-sm',
    accentHex: '#2563eb',
    hasSubgrades: true,
    lookupUrl: (cert: string) => `https://www.cgccards.com/certlookup/${encodeURIComponent(cert.trim())}`
  },
  { 
    id: 'SGC', 
    name: 'SGC (Sportscard Guaranty)', 
    shortName: 'SGC',
    badgeClass: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    pillClass: 'bg-slate-900 text-white border border-slate-700 shadow-sm',
    accentHex: '#18181b',
    hasSubgrades: false,
    lookupUrl: (cert: string) => `https://www.gosgc.com/cert-code-lookup`
  },
  { 
    id: 'ACE', 
    name: 'ACE Grading', 
    shortName: 'ACE',
    badgeClass: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    pillClass: 'bg-purple-600 text-white shadow-sm',
    accentHex: '#9333ea',
    hasSubgrades: true,
    lookupUrl: (cert: string) => `https://acegrading.com/lookup/${encodeURIComponent(cert.trim())}`
  },
  { 
    id: 'OTHER', 
    name: 'Otra Empresa Certificadora', 
    shortName: 'Graded',
    badgeClass: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    pillClass: 'bg-slate-700 text-white shadow-sm',
    accentHex: '#475569',
    hasSubgrades: true,
    lookupUrl: () => undefined
  }
];

export const COMMON_GRADES = [
  '10 Gem Mint',
  '10 Pristine',
  '9.5 Mint+',
  '9 Mint',
  '8.5 NM-MT+',
  '8 Near Mint-Mint',
  '7.5',
  '7 Near Mint',
  '6 Excellent-Mint',
  '5 Excellent',
  '4 Very Good-Excellent',
  '3 Very Good',
  '2 Good',
  '1 Poor / Authentic',
  'Authentic (No Grade)'
];

export function getCompanyMeta(companyId: string = '') {
  const cleanId = (companyId || '').trim().toUpperCase();
  const found = GRADING_COMPANIES.find(c => c.id === cleanId || cleanId.includes(c.id));
  return found || GRADING_COMPANIES[GRADING_COMPANIES.length - 1];
}

export function getCertVerificationUrl(company: string = '', certNumber: string = ''): string | undefined {
  if (!certNumber || !certNumber.trim()) return undefined;
  const meta = getCompanyMeta(company);
  return meta.lookupUrl ? meta.lookupUrl(certNumber) : undefined;
}

const TAG_REGEX = /\[GRADED:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]/;
const SUBGRADES_REGEX = /\[SUBGRADES:([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]/;

/**
 * Formatea los subgrados en un texto compacto legible para badges y detalles.
 */
export function formatSubgradesCompact(subgrades?: CardSubgrades): string {
  if (!subgrades) return '';
  const parts: string[] = [];
  if (subgrades.centering) parts.push(`C: ${subgrades.centering}`);
  if (subgrades.corners) parts.push(`Cr: ${subgrades.corners}`);
  if (subgrades.edges) parts.push(`E: ${subgrades.edges}`);
  if (subgrades.surface) parts.push(`S: ${subgrades.surface}`);
  return parts.join(' · ');
}

/**
 * Extrae la información de graduación comprobando las columnas dedicadas
 * y, si no existen o están vacías, comprobando si está codificado en `notes`.
 */
export function getGradingInfo(listing: any): CardGrading {
  if (!listing) {
    return { isGraded: false, company: '', score: '', certNumber: '' };
  }

  // 0. Comprobar si está en extra_images.grading (subastas)
  if (listing.extra_images && typeof listing.extra_images === 'object') {
    const g = listing.extra_images.grading;
    if (g && (g.isGraded || g.company)) {
      const company = g.company || 'PSA';
      const score = g.score || '10 Gem Mint';
      const certNumber = g.certNumber || '';
      return {
        isGraded: true,
        company,
        score,
        certNumber,
        certUrl: getCertVerificationUrl(company, certNumber),
        subgrades: g.subgrades
      };
    }
  }

  const notesStr = listing.notes || listing.description || '';
  let subgrades: CardSubgrades | undefined = undefined;

  // Extraer subgrados si están presentes en notes
  const subMatch = notesStr.match(SUBGRADES_REGEX);
  if (subMatch) {
    subgrades = {
      centering: subMatch[1] || undefined,
      corners: subMatch[2] || undefined,
      edges: subMatch[3] || undefined,
      surface: subMatch[4] || undefined,
    };
  }

  // 1. Columnas dedicadas
  if (listing.is_graded || listing.grading_company) {
    const company = listing.grading_company || 'PSA';
    const score = listing.grading_score || '10 Gem Mint';
    const certNumber = listing.grading_cert_number || '';
    return {
      isGraded: true,
      company,
      score,
      certNumber,
      certUrl: getCertVerificationUrl(company, certNumber),
      subgrades
    };
  }

  // 2. Extraer de notes si fue guardado con fallback
  const match = notesStr.match(TAG_REGEX);
  if (match) {
    const company = match[1] || 'PSA';
    const score = match[2] || '10 Gem Mint';
    const certNumber = match[3] || '';
    return {
      isGraded: true,
      company,
      score,
      certNumber,
      certUrl: getCertVerificationUrl(company, certNumber),
      subgrades
    };
  }

  return { isGraded: false, company: '', score: '', certNumber: '' };
}

/**
 * Codifica la información de graduación en la cadena de notas (fallback si la tabla no tiene las columnas).
 */
export function encodeGradingInNotes(
  existingNotes: string | null | undefined, 
  grading: { 
    isGraded: boolean; 
    company: string; 
    score: string; 
    certNumber: string;
    subgrades?: CardSubgrades;
  }
): string {
  let clean = (existingNotes || '')
    .replace(TAG_REGEX, '')
    .replace(SUBGRADES_REGEX, '')
    .trim();

  if (!grading.isGraded) {
    return clean;
  }

  const tag = `[GRADED:${grading.company.trim().toUpperCase()}|${grading.score.trim()}|${grading.certNumber.trim()}]`;
  let result = clean ? `${clean}\n${tag}` : tag;

  if (grading.subgrades && (grading.subgrades.centering || grading.subgrades.corners || grading.subgrades.edges || grading.subgrades.surface)) {
    const subTag = `[SUBGRADES:${grading.subgrades.centering || ''}|${grading.subgrades.corners || ''}|${grading.subgrades.edges || ''}|${grading.subgrades.surface || ''}]`;
    result += `\n${subTag}`;
  }

  return result;
}

/**
 * Limpia las notas públicas para no mostrar el tag de fallback al usuario final.
 */
export function cleanPublicNotes(notes: string | null | undefined): string {
  if (!notes) return '';
  return notes
    .replace(TAG_REGEX, '')
    .replace(SUBGRADES_REGEX, '')
    .replace(/\[PRIV:\s*[\s\S]*?\s*\]/g, '')
    .replace(/\[PRIVATE:[^\]]*\]/g, '')
    .trim();
}

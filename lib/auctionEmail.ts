import { supabaseAdmin } from './supabase-admin'
import { sendPlatformEmail, SITE_URL } from './mailer'

interface OutbidEmailParams {
  toEmail: string
  username?: string
  cardName: string
  cardImage?: string
  newBid: number
  auctionId: string
  game?: string
  lang?: string
  endsAt?: string
}

/**
 * Sends a high-converting, branded outbid notification email to a bidder
 * who has just been outbid by a competitor or an automated proxy bid.
 */
export async function sendOutbidNotificationEmail({
  toEmail,
  username,
  cardName,
  cardImage,
  newBid,
  auctionId,
  game = 'yugioh',
  lang = 'es',
  endsAt
}: OutbidEmailParams) {
  try {
    const esc = (str?: string | null) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const safeCardName = esc(cardName);
    const safeUsername = esc(username);
    const safeCardImage = cardImage ? esc(cardImage) : null;

    const baseUrl = SITE_URL
    const auctionUrl = `${baseUrl}/${lang}/${game}/subasta/${auctionId}`
    const formattedPrice = Number(newBid).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'

    const greeting = safeUsername ? `Hola ${safeUsername},` : 'Hola,'
    const endsFormatted = endsAt ? new Date(endsAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Muy pronto'

    const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>¡Te han sobrepujado! - EuropeTCG</title>
  <style>
    body { margin:0; padding:0; background-color:#0d0619; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff; }
    .container { max-width:600px; margin:0 auto; background-color:#180d2c; border:1px solid #351f58; border-radius:24px; overflow:hidden; }
    .header { background:linear-gradient(135deg, #251545 0%, #180d2c 100%); padding:28px 24px; text-align:center; border-bottom:1px solid #351f58; }
    .badge { display:inline-block; background:rgba(255, 68, 102, 0.15); border:1px solid rgba(255, 68, 102, 0.4); color:#ff4466; font-size:11px; font-weight:800; letter-spacing:2px; text-transform:uppercase; padding:6px 14px; border-radius:999px; margin-bottom:12px; }
    .title { font-size:26px; font-weight:900; margin:0; color:#ffffff; text-transform:uppercase; letter-spacing:-0.5px; }
    .content { padding:32px 28px; }
    .card-box { background:#120924; border:1px solid #351f58; border-radius:18px; padding:20px; margin:24px 0; text-align:center; }
    .card-thumb { max-height:220px; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5); margin-bottom:16px; }
    .card-name { font-size:20px; font-weight:900; color:#ffd23f; margin:0 0 8px 0; }
    .price-box { background:rgba(46, 230, 166, 0.1); border:1px solid rgba(46, 230, 166, 0.3); border-radius:14px; padding:16px; margin-top:16px; }
    .price-label { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:1px; color:#a1a1aa; margin:0 0 4px 0; }
    .price-val { font-size:32px; font-weight:900; color:#2ee6a6; margin:0; }
    .cta-btn { display:inline-block; width:100%; box-sizing:border-box; background:linear-gradient(90deg, #ffd23f 0%, #ffaa00 100%); color:#0d0619; text-decoration:none; font-weight:900; font-size:15px; text-transform:uppercase; letter-spacing:1px; padding:18px 24px; border-radius:14px; text-align:center; margin-top:24px; box-shadow:0 8px 24px rgba(255, 210, 63, 0.3); }
    .footer { padding:24px; text-align:center; font-size:12px; color:#71717a; border-top:1px solid #251545; background:#0f071f; }
  </style>
</head>
<body>
  <div style="padding:24px 12px;">
    <div class="container">
      <div class="header">
        <div class="badge">⚡ ALERTA DE SUBASTA EN VIVO</div>
        <h1 class="title">¡Te han sobrepujado!</h1>
      </div>
      <div class="content">
        <p style="font-size:16px; line-height:1.5; margin:0 0 16px 0; color:#e4e4e7;">
          ${greeting}
        </p>
        <p style="font-size:14px; line-height:1.6; margin:0; color:#a1a1aa;">
          Otro coleccionista acaba de pujar más alto por una carta en la que estabas liderando. ¡No dejes que se te escape de las manos en los momentos decisivos!
        </p>

        <div class="card-box">
          ${safeCardImage ? `<img src="${safeCardImage}" alt="${safeCardName}" class="card-thumb" />` : ''}
          <div class="card-name">${safeCardName}</div>
          <div style="font-size:12px; color:#71717a;">Finaliza: <strong style="color:#ffffff;">${endsFormatted}</strong></div>

          <div class="price-box">
            <div class="price-label">Nueva Puja Más Alta</div>
            <div class="price-val">${formattedPrice}</div>
          </div>
        </div>

        <p style="font-size:13px; line-height:1.5; color:#a1a1aa; text-align:center; margin:0 0 8px 0;">
          💡 <em>Tip: Puedes usar la <strong>Puja Máxima Automática (Proxy)</strong> para que el sistema defienda tu oferta en piloto automático hasta el tope que tú decidas.</em>
        </p>

        <a href="${auctionUrl}" class="cta-btn" target="_blank">
          🔥 RECUPERAR MI PUJA AHORA ➔
        </a>
      </div>
      <div class="footer">
        <p style="margin:0 0 6px 0;">EuropeTCG Marketplace • Subastas en Vivo & Escrow Protegido</p>
        <p style="margin:0; font-size:10px; color:#52525b;">Recibes este aviso porque participaste activamente en esta subasta.</p>
      </div>
    </div>
  </div>
</body>
</html>
`

    const res = await sendPlatformEmail({
      fromName: 'EuropeTCG Subastas',
      fromEmail: process.env.BREVO_SENDER_EMAIL || 'subastas@europetcg.eu',
      to: toEmail,
      subject: `⚡ ¡Te han sobrepujado en "${cardName}"! (Puja actual: ${formattedPrice})`,
      html: htmlContent,
    })

    return res
  } catch (error: any) {
    console.error('[OutbidEmail] Error dispatching outbid email:', error.message || error)
    return { success: false, error: error.message }
  }
}

/**
 * Helper to lookup user email from auth admin and fire outbid email asynchronously
 */
export async function notifyOutbidUser(userId: string, auctionData: {
  id: string
  card_name: string
  image_url?: string
  current_bid: number
  game?: string
  ends_at?: string
}) {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (error || !data?.user?.email) {
      console.warn('[OutbidEmail] Could not retrieve email for user:', userId, error?.message)
      return
    }

    const email = data.user.email
    const username = data.user.user_metadata?.username || data.user.email.split('@')[0]

    // Send without blocking execution
    sendOutbidNotificationEmail({
      toEmail: email,
      username,
      cardName: auctionData.card_name,
      cardImage: auctionData.image_url,
      newBid: auctionData.current_bid,
      auctionId: auctionData.id,
      game: auctionData.game || 'yugioh',
      endsAt: auctionData.ends_at
    }).catch(err => console.error('[OutbidEmail] Async send failed:', err))
  } catch (err) {
    console.error('[OutbidEmail] Failed in notifyOutbidUser:', err)
  }
}

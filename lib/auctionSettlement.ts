import { supabaseAdmin } from './supabase-admin'
import { sendPlatformEmail, SITE_URL } from './mailer'
import { escapeHtml } from './security'
import { getAuctionSecret } from './auction-helpers'

export interface SettleAuctionResult {
  settled: boolean
  auctionId: string
  winnerId: string | null
  winnerPrice: number | null
  error?: string
}

/**
 * Concurrency-safe helper to settle an expired auction.
 * Atomically transitions status from 'active' to 'ended', assigns winner and final price,
 * and notifies both the winner and seller via internal messages and transactional emails.
 */
export async function settleAuction(auction: {
  id: string
  seller_id: string
  game?: string
  card_name: string
  image_url?: string
  current_bid: number | string
  current_bidder_id?: string | null
  reserve_price?: number | string | null
  status?: string
}): Promise<SettleAuctionResult> {
  try {
    let effectiveReserve = auction.reserve_price
    if (effectiveReserve === undefined) {
      const secret = await getAuctionSecret(auction.id)
      effectiveReserve = secret?.reserve_price ?? null
    }
    const metReserve = !effectiveReserve || Number(auction.current_bid) >= Number(effectiveReserve)
    const winnerId = (metReserve && auction.current_bidder_id) ? auction.current_bidder_id : null
    const winnerPrice = (metReserve && auction.current_bidder_id) ? Number(auction.current_bid) : null

    // Optimistic concurrency control: only update if still 'active'
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('auctions')
      .update({
        status: 'ended',
        winner_id: winnerId,
        winner_price: winnerPrice,
        updated_at: new Date().toISOString()
      })
      .eq('id', auction.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle()

    if (updateErr) {
      console.error(`[AuctionSettlement] Update error for auction ${auction.id}:`, updateErr)
      return { settled: false, auctionId: auction.id, winnerId: null, winnerPrice: null, error: updateErr.message }
    }

    // Another process (cron or concurrent user request) already settled this auction
    if (!updated) {
      return { settled: false, auctionId: auction.id, winnerId, winnerPrice }
    }

    const auctionUrl = `${SITE_URL}/es/${auction.game || 'yugioh'}/subasta/${auction.id}`
    const formattedPrice = winnerPrice ? winnerPrice.toFixed(2).replace('.', ',') : '0,00'

    if (winnerId && winnerPrice) {
      // 1. Notificación interna al ganador
      try {
        await supabaseAdmin.from('messages').insert({
          sender_id: auction.seller_id,
          receiver_id: winnerId,
          content: `🏆 ¡Felicidades! Has ganado la subasta de "${auction.card_name}" por ${formattedPrice} €. Tienes 48h para tramitar el pago con Fideicomiso Trustee en la sala: /es/${auction.game || 'yugioh'}/subasta/${auction.id}`,
          is_read: false
        })
      } catch (msgErr) {
        console.warn(`[AuctionSettlement] Could not insert winner message:`, msgErr)
      }

      // 2. Emails transaccionales a ganador y vendedor
      try {
        const [winnerAuth, sellerAuth] = await Promise.all([
          supabaseAdmin.auth.admin.getUserById(winnerId),
          supabaseAdmin.auth.admin.getUserById(auction.seller_id)
        ])

        const winnerEmail = winnerAuth.data?.user?.email
        const sellerEmail = sellerAuth.data?.user?.email
        const safeCardName = escapeHtml(auction.card_name)

        if (winnerEmail) {
          await sendPlatformEmail({
            fromName: 'EuropeTCG Subastas',
            to: winnerEmail,
            subject: `🏆 ¡Has ganado la subasta de ${safeCardName}!`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #0d0619; color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #351f58;">
                <div style="background: linear-gradient(135deg, #180d2c, #120924); padding: 28px; text-align: center; border-bottom: 1px solid #351f58;">
                  <span style="display: inline-block; background-color: rgba(46,230,166,0.15); color: #2ee6a6; border: 1px solid rgba(46,230,166,0.4); font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 999px; text-transform: uppercase;">
                    🏆 Subasta Adjudicada
                  </span>
                  <h2 style="margin: 14px 0 0 0; font-size: 22px; font-weight: 900; color: #ffffff;">
                    ¡Eres el ganador oficial!
                  </h2>
                </div>
                <div style="padding: 28px;">
                  <p style="font-size: 15px; color: #e2e8f0; line-height: 1.6;">
                    La subasta de <strong style="color: #ffd23f;">${safeCardName}</strong> ha finalizado con tu puja ganadora de <strong style="color: #2ee6a6;">${formattedPrice} €</strong>.
                  </p>
                  <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                    Dispones de <strong>48 horas</strong> para completar el pago protegido con Fideicomiso Trustee desde la sala de la subasta.
                  </p>
                  <div style="text-align: center; margin-top: 24px;">
                    <a href="${auctionUrl}" style="display: inline-block; background-color: #ffd23f; color: #0d0619; text-decoration: none; font-weight: 900; font-size: 14px; padding: 14px 28px; border-radius: 12px; text-transform: uppercase;">
                      Tramitar Pago Seguro (${formattedPrice} €) →
                    </a>
                  </div>
                </div>
              </div>
            `
          }).catch(err => console.error('[AuctionSettlement] Winner email error:', err))
        }

        if (sellerEmail) {
          await sendPlatformEmail({
            fromName: 'EuropeTCG Subastas',
            to: sellerEmail,
            subject: `🎉 Tu subasta de ${safeCardName} se ha vendido por ${formattedPrice} €`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #0d0619; color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #351f58;">
                <div style="padding: 28px;">
                  <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 900; color: #ffd23f;">
                    ¡Subasta finalizada con comprador!
                  </h2>
                  <p style="font-size: 15px; color: #e2e8f0; line-height: 1.6;">
                    Tu subasta de <strong>${safeCardName}</strong> ha terminado con una puja ganadora de <strong style="color: #2ee6a6;">${formattedPrice} €</strong>.
                  </p>
                  <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                    Hemos enviado un aviso al ganador para que complete el pago en las próximas 48 horas. Te avisaremos en cuanto los fondos estén en custodia para que prepares el envío.
                  </p>
                  <div style="margin-top: 20px;">
                    <a href="${auctionUrl}" style="display: inline-block; background-color: #180d2c; color: #ffd23f; border: 1px solid #ffd23f; text-decoration: none; font-weight: 800; font-size: 13px; padding: 12px 22px; border-radius: 10px;">
                      Ver Sala de Subasta
                    </a>
                  </div>
                </div>
              </div>
            `
          }).catch(err => console.error('[AuctionSettlement] Seller email error:', err))
        }
      } catch (mailErr) {
        console.error('[AuctionSettlement] Error sending auction settlement emails:', mailErr)
      }
    }

    return { settled: true, auctionId: auction.id, winnerId, winnerPrice }
  } catch (err: any) {
    console.error(`[AuctionSettlement] Exception settling auction ${auction.id}:`, err)
    return { settled: false, auctionId: auction.id, winnerId: null, winnerPrice: null, error: err.message }
  }
}

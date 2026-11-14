import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { rateLimit } from '@/lib/rate-limit'
import { notifyOutbidUser } from '@/lib/auctionEmail'
import { settleAuction } from '@/lib/auctionSettlement'
import { sendPlatformEmail, SITE_URL } from '@/lib/mailer'
import { escapeHtml } from '@/lib/security'
import { getAuctionSecret, maskAuctionForClient, saveAuctionProxyLeader } from '@/lib/auction-helpers'

const MAX_AUCTION_BID_EUR = 500000;

export async function POST(req: Request) {
  try {
    // 0. RATE LIMITING (Anti-bot flooding: max 15 requests per 10s per IP)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
               req.headers.get('x-real-ip') || 
               'anonymous'
    const limitCheck = rateLimit(`bid_${ip}`, 15, 10000)
    if (!limitCheck.success) {
      return NextResponse.json({ 
        error: 'Demasiadas solicitudes de puja en poco tiempo. Espera unos segundos e intenta nuevamente.' 
      }, { status: 429 })
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'No authorization header' }, { status: 401 })
    }

    const token = authHeader.replace('Bearer ', '')
    const supabaseClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    )

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { auctionId, amount, action, isProxy, maxAmount } = body

    if (!auctionId) {
      return NextResponse.json({ error: 'Falta auctionId' }, { status: 400 })
    }

    const isProxyBid = Boolean(isProxy)
    const rawTarget = isProxyBid ? (maxAmount || amount) : amount

    if (action !== 'buy_now' && !rawTarget) {
      return NextResponse.json({ error: 'Faltan parámetros requeridos (auctionId, amount)' }, { status: 400 })
    }

    const targetAmount = Math.round(Number(rawTarget) * 100) / 100
    if (action !== 'buy_now' && (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > MAX_AUCTION_BID_EUR)) {
      return NextResponse.json({ error: `El monto de la puja no es válido (máximo permitido: ${MAX_AUCTION_BID_EUR.toLocaleString('es-ES')} €)` }, { status: 400 })
    }

    // Fetch auction + confidential secrets in parallel
    const [{ data: auction, error: fetchErr }, secret] = await Promise.all([
      supabaseAdmin
        .from('auctions')
        .select('*')
        .eq('id', auctionId)
        .single(),
      getAuctionSecret(auctionId),
    ])

    if (fetchErr || !auction) {
      return NextResponse.json({ error: 'Subasta no encontrada' }, { status: 404 })
    }

    if (auction.status !== 'active') {
      return NextResponse.json({ error: 'Esta subasta ya no está activa' }, { status: 400 })
    }

    const now = Date.now()
    const endsAtTime = new Date(auction.ends_at).getTime()

    if (now >= endsAtTime) {
      await settleAuction({
        ...auction,
        reserve_price: secret?.reserve_price ?? null,
      })
      return NextResponse.json({ error: 'Esta subasta acaba de finalizar' }, { status: 400 })
    }

    if (auction.seller_id === user.id) {
      return NextResponse.json({ error: 'No puedes interactuar en tu propia subasta' }, { status: 400 })
    }

    // Prepare public extra_images container (never keep proxy_leader in public auctions table)
    let extraImagesData: any = {}
    if (typeof auction.extra_images === 'object' && auction.extra_images !== null && !Array.isArray(auction.extra_images)) {
      extraImagesData = { ...auction.extra_images }
      delete extraImagesData.proxy_leader
    } else if (Array.isArray(auction.extra_images)) {
      extraImagesData = { images: auction.extra_images }
    }

    const currentProxyLeader = (secret?.proxy_leader && secret.proxy_leader.bidder_id === auction.current_bidder_id)
      ? secret.proxy_leader
      : null

    // 1. GESTIÓN DE CÓMPRALO YA (INSTANT BUYOUT)
    if (action === 'buy_now') {
      const buyNowPrice = typeof auction.extra_images === 'object' && !Array.isArray(auction.extra_images)
        ? auction.extra_images?.buy_now_price
        : (Array.isArray(auction.extra_images) ? auction.extra_images.find((x: any) => x?.buy_now_price)?.buy_now_price : null);

      const finalPrice = Number(buyNowPrice)
      if (!buyNowPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
        return NextResponse.json({ error: 'Esta subasta no tiene habilitada la opción de Cómpralo Ya' }, { status: 400 })
      }

      if (Number(auction.current_bid) >= finalPrice) {
        return NextResponse.json({ error: 'La opción de Cómpralo Ya ya no está disponible porque las pujas han alcanzado dicho importe.' }, { status: 400 })
      }

      if (currentProxyLeader && currentProxyLeader.bidder_id !== user.id && Number(currentProxyLeader.max_bid) >= finalPrice) {
        return NextResponse.json({ error: 'La opción de Cómpralo Ya ya no está disponible porque la puja máxima automática de otro postor iguala o supera este importe.' }, { status: 400 })
      }

      // Cerrar subasta de inmediato con bloqueo concurrente
      const { data: updatedAuction, error: updateErr } = await supabaseAdmin
        .from('auctions')
        .update({
          status: 'ended',
          winner_id: user.id,
          winner_price: finalPrice,
          current_bid: finalPrice,
          current_bidder_id: user.id,
          extra_images: extraImagesData,
          total_bids: (auction.total_bids || 0) + 1,
          ends_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', auctionId)
        .eq('status', 'active')
        .eq('current_bid', auction.current_bid)
        .eq('total_bids', auction.total_bids || 0)
        .select('*')
        .maybeSingle()

      if (updateErr || !updatedAuction) {
        return NextResponse.json({ error: 'La subasta ya no está activa o fue finalizada concurrentemente.' }, { status: 409 })
      }

      const nextSecret = await saveAuctionProxyLeader(auctionId, auction.seller_id, secret, null)

      // Registrar puja ganadora final
      await supabaseAdmin.from('auction_bids').insert({
        auction_id: auctionId,
        bidder_id: user.id,
        amount: finalPrice
      })

      // Notificar al vendedor y al comprador (mensaje interno + emails transaccionales)
      const formattedBuyNow = finalPrice.toFixed(2).replace('.', ',')
      const auctionUrl = `${SITE_URL}/es/${auction.game || 'yugioh'}/subasta/${auctionId}`
      try {
        await supabaseAdmin.from('messages').insert({
          sender_id: user.id,
          receiver_id: auction.seller_id,
          content: `⚡ ¡Compra inmediata! Un comprador ha adquirido "${auction.card_name}" usando Cómpralo Ya por ${formattedBuyNow} €. Dispone de 48 horas para formalizar el pago en custodia.`,
          is_read: false
        })
      } catch (errNotify) {
        console.warn('Could not notify seller about buy now:', errNotify)
      }

      try {
        const [buyerAuth, sellerAuth] = await Promise.all([
          supabaseAdmin.auth.admin.getUserById(user.id),
          supabaseAdmin.auth.admin.getUserById(auction.seller_id)
        ])
        const buyerEmail = buyerAuth.data?.user?.email
        const sellerEmail = sellerAuth.data?.user?.email
        const safeCardName = escapeHtml(auction.card_name)

        if (buyerEmail) {
          await sendPlatformEmail({
            fromName: 'EuropeTCG Subastas',
            to: buyerEmail,
            subject: `⚡ ¡Has adquirido ${safeCardName} con Cómpralo Ya!`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #0d0619; color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #351f58;">
                <div style="padding: 28px;">
                  <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 900; color: #2ee6a6;">¡Adjudicación inmediata confirmada!</h2>
                  <p style="font-size: 15px; color: #e2e8f0; line-height: 1.6;">
                    Has adquirido <strong style="color: #ffd23f;">${safeCardName}</strong> mediante <strong>Cómpralo Ya</strong> por <strong style="color: #2ee6a6;">${formattedBuyNow} €</strong>.
                  </p>
                  <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                    Dispones de <strong>48 horas</strong> para tramitar el pago protegido con Fideicomiso Trustee desde la sala de la subasta o tu panel de subastas.
                  </p>
                  <div style="margin-top: 22px;">
                    <a href="${auctionUrl}" style="display: inline-block; background-color: #ffd23f; color: #0d0619; text-decoration: none; font-weight: 900; font-size: 14px; padding: 12px 24px; border-radius: 12px; text-transform: uppercase;">
                      Tramitar Pago Seguro (${formattedBuyNow} €) →
                    </a>
                  </div>
                </div>
              </div>
            `
          }).catch(err => console.error('[BuyNow] Buyer email error:', err))
        }

        if (sellerEmail) {
          await sendPlatformEmail({
            fromName: 'EuropeTCG Subastas',
            to: sellerEmail,
            subject: `⚡ ¡Tu subasta de ${safeCardName} se ha vendido con Cómpralo Ya (${formattedBuyNow} €)!`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #0d0619; color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #351f58;">
                <div style="padding: 28px;">
                  <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 900; color: #ffd23f;">¡Venta inmediata por Cómpralo Ya!</h2>
                  <p style="font-size: 15px; color: #e2e8f0; line-height: 1.6;">
                    Un comprador ha ejecutado la opción <strong>Cómpralo Ya</strong> en tu subasta de <strong>${safeCardName}</strong> por <strong style="color: #2ee6a6;">${formattedBuyNow} €</strong>.
                  </p>
                  <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                    El comprador dispone de 48 horas para completar el pago en custodia. Recibirás otro correo en cuanto el pedido quede pagado y listo para enviar.
                  </p>
                  <div style="margin-top: 20px;">
                    <a href="${auctionUrl}" style="display: inline-block; background-color: #180d2c; color: #ffd23f; border: 1px solid #ffd23f; text-decoration: none; font-weight: 800; font-size: 13px; padding: 12px 22px; border-radius: 10px;">
                      Ver Sala de Subasta
                    </a>
                  </div>
                </div>
              </div>
            `
          }).catch(err => console.error('[BuyNow] Seller email error:', err))
        }
      } catch (mailErr) {
        console.warn('[BuyNow] Could not send buy_now emails:', mailErr)
      }

      return NextResponse.json({
        success: true,
        boughtNow: true,
        auction: { ...maskAuctionForClient(updatedAuction, nextSecret, user.id, true), buy_now_price: finalPrice },
        message: `¡Has adquirido la carta con éxito por ${finalPrice.toFixed(2).replace('.', ',')} €!`
      })
    }

    const reserveAmount = secret?.reserve_price ? Number(secret.reserve_price) : 0
    const isBelowReserve = reserveAmount > 0 && Number(auction.current_bid) < reserveAmount

    // If user is already the current highest bidder
    if (auction.current_bidder_id === user.id) {
      if (isProxyBid) {
        if (currentProxyLeader) {
          if (targetAmount > Number(currentProxyLeader.max_bid)) {
            const nextProxyLeader = {
              bidder_id: user.id,
              max_bid: targetAmount
            }
            const newVisibleBid = isBelowReserve
              ? Math.min(targetAmount, reserveAmount)
              : Number(auction.current_bid)
            const bidAdvanced = newVisibleBid > Number(auction.current_bid)

            const { data: updatedProxy, error: proxyErr } = await supabaseAdmin
              .from('auctions')
              .update({
                current_bid: newVisibleBid,
                total_bids: bidAdvanced ? (auction.total_bids || 0) + 1 : auction.total_bids,
                extra_images: extraImagesData,
                updated_at: new Date().toISOString()
              })
              .eq('id', auctionId)
              .eq('current_bidder_id', user.id)
              .eq('status', 'active')
              .eq('current_bid', auction.current_bid)
              .eq('total_bids', auction.total_bids || 0)
              .select('*')
              .maybeSingle()

            if (proxyErr || !updatedProxy) {
              return NextResponse.json({ error: 'La subasta cambió de estado mientras actualizabas tu puja máxima. Inténtalo de nuevo.' }, { status: 409 })
            }

            const nextSecret = await saveAuctionProxyLeader(auctionId, auction.seller_id, secret, nextProxyLeader)

            if (bidAdvanced) {
              await supabaseAdmin.from('auction_bids').insert({
                auction_id: auctionId,
                bidder_id: user.id,
                amount: newVisibleBid
              })
            }

            return NextResponse.json({
              success: true,
              isProxy: true,
              proxyUpdated: true,
              auction: maskAuctionForClient(updatedProxy, nextSecret, user.id, true),
              message: `¡Puja máxima actualizada con éxito a ${targetAmount.toFixed(2).replace('.', ',')} €! El sistema defenderá tu oferta automáticamente.`
            })
          } else {
            return NextResponse.json({
              error: `Tu puja máxima actual ya es de ${Number(currentProxyLeader.max_bid).toFixed(2).replace('.', ',')} €. Para aumentarla ingresa un monto mayor.`
            }, { status: 400 })
          }
        } else {
          // Add proxy to existing winning bidder
          const minRequiredForProxy = Number(auction.current_bid) + Number(auction.min_bid_increment || 1.00)
          if (targetAmount < minRequiredForProxy) {
            return NextResponse.json({
              error: `Tu puja máxima debe ser de al menos ${minRequiredForProxy.toFixed(2).replace('.', ',')} € (puja actual + incremento mínimo)`
            }, { status: 400 })
          }
          const nextProxyLeader = {
            bidder_id: user.id,
            max_bid: targetAmount
          }
          const newVisibleBid = isBelowReserve
            ? Math.min(targetAmount, reserveAmount)
            : Number(auction.current_bid)
          const bidAdvanced = newVisibleBid > Number(auction.current_bid)

          const { data: updatedProxy, error: proxyErr } = await supabaseAdmin
            .from('auctions')
            .update({
              current_bid: newVisibleBid,
              total_bids: bidAdvanced ? (auction.total_bids || 0) + 1 : auction.total_bids,
              extra_images: extraImagesData,
              updated_at: new Date().toISOString()
            })
            .eq('id', auctionId)
            .eq('current_bidder_id', user.id)
            .eq('status', 'active')
            .eq('current_bid', auction.current_bid)
            .eq('total_bids', auction.total_bids || 0)
            .select('*')
            .maybeSingle()

          if (proxyErr || !updatedProxy) {
            return NextResponse.json({ error: 'La subasta cambió de estado mientras activabas tu puja máxima. Inténtalo de nuevo.' }, { status: 409 })
          }

          const nextSecret = await saveAuctionProxyLeader(auctionId, auction.seller_id, secret, nextProxyLeader)

          if (bidAdvanced) {
            await supabaseAdmin.from('auction_bids').insert({
              auction_id: auctionId,
              bidder_id: user.id,
              amount: newVisibleBid
            })
          }

          return NextResponse.json({
            success: true,
            isProxy: true,
            proxyUpdated: true,
            auction: maskAuctionForClient(updatedProxy, nextSecret, user.id, true),
            message: `¡Puja máxima automática activada en ${targetAmount.toFixed(2).replace('.', ',')} €!`
          })
        }
      } else if (!isBelowReserve) {
        return NextResponse.json({ error: 'Ya tienes la puja más alta en esta subasta' }, { status: 400 })
      }
    }

    // Min required amount
    const increment = Number(auction.min_bid_increment || 1.00)
    const minRequired = auction.total_bids === 0
      ? Number(auction.starting_price)
      : Math.round((Number(auction.current_bid) + increment) * 100) / 100

    if (targetAmount < minRequired) {
      return NextResponse.json({ 
        error: `La puja mínima permitida es de ${minRequired.toFixed(2).replace('.', ',')} €` 
      }, { status: 400 })
    }

    // ANTI-SNIPING SYSTEM:
    const antiSnipingMs = (auction.anti_sniping_seconds || 120) * 1000
    const remainingMs = endsAtTime - now
    let newEndsAt = auction.ends_at
    let antiSnipingTriggered = false

    if (remainingMs < antiSnipingMs) {
      const extendedTime = new Date(endsAtTime + antiSnipingMs)
      newEndsAt = extendedTime.toISOString()
      antiSnipingTriggered = true
    }

    const previousBidderId = auction.current_bidder_id

    // =========================================================================
    // PROXY BIDDING ENGINE (eBay / Catawiki Standard Algorithm)
    // =========================================================================
    
    // CASE 1: THERE IS AN ACTIVE PROXY LEADER DEFENDING THE AUCTION
    if (currentProxyLeader && currentProxyLeader.bidder_id !== user.id) {
      const leaderMax = Number(currentProxyLeader.max_bid)
      const leaderId = currentProxyLeader.bidder_id

      if (targetAmount <= leaderMax) {
        // --- SUBCASE 1A: Existing proxy leader DEFENDS lead ---
        let defendedBid = Math.min(leaderMax, Math.round((targetAmount + increment) * 100) / 100)
        if (reserveAmount > 0 && leaderMax >= reserveAmount && defendedBid < reserveAmount) {
          defendedBid = reserveAmount
        }

        // 1. Update auction FIRST with optimistic concurrency guard before inserting bid history
        const { data: updatedAuction, error: updateErr } = await supabaseAdmin
          .from('auctions')
          .update({
            current_bid: defendedBid,
            current_bidder_id: leaderId,
            total_bids: (auction.total_bids || 0) + 2,
            ends_at: newEndsAt,
            updated_at: new Date().toISOString()
          })
          .eq('id', auctionId)
          .eq('current_bid', auction.current_bid)
          .eq('total_bids', auction.total_bids || 0)
          .eq('status', 'active')
          .select('*')
          .maybeSingle()

        if (updateErr || !updatedAuction) {
          return NextResponse.json({ 
            error: 'La subasta ha recibido una puja simultánea de otro participante. Por favor, inténtalo de nuevo.' 
          }, { status: 409 })
        }

        // 2. Record challenger's bid and leader's automated defense counter-bid
        await supabaseAdmin.from('auction_bids').insert([
          {
            auction_id: auctionId,
            bidder_id: user.id,
            amount: targetAmount
          },
          {
            auction_id: auctionId,
            bidder_id: leaderId,
            amount: defendedBid
          }
        ])

        return NextResponse.json({
          success: true,
          outbidImmediately: true,
          currentBid: defendedBid,
          auction: maskAuctionForClient(updatedAuction, secret, user.id, true),
          antiSnipingTriggered,
          message: `Has sido superado automáticamente por la puja máxima preexistente de otro postor. La puja actual ahora es de ${defendedBid.toFixed(2).replace('.', ',')} €.`
        })
      } else {
        // --- SUBCASE 1B: Challenger OVERTAKES the proxy leader ---
        let winningVisibleBid = isProxyBid
          ? Math.min(targetAmount, Math.round((leaderMax + increment) * 100) / 100)
          : targetAmount
        if (isProxyBid && reserveAmount > 0 && winningVisibleBid < reserveAmount) {
          winningVisibleBid = Math.min(targetAmount, reserveAmount)
        }

        const nextProxyLeader = isProxyBid
          ? { bidder_id: user.id, max_bid: targetAmount }
          : null

        const { data: updatedAuction, error: updateErr } = await supabaseAdmin
          .from('auctions')
          .update({
            current_bid: winningVisibleBid,
            current_bidder_id: user.id,
            extra_images: extraImagesData,
            total_bids: (auction.total_bids || 0) + 2,
            ends_at: newEndsAt,
            updated_at: new Date().toISOString()
          })
          .eq('id', auctionId)
          .eq('current_bid', auction.current_bid)
          .eq('total_bids', auction.total_bids || 0)
          .eq('status', 'active')
          .select('*')
          .maybeSingle()

        if (updateErr || !updatedAuction) {
          return NextResponse.json({ 
            error: 'La subasta ha recibido una puja simultánea de otro participante. Por favor, inténtalo de nuevo.' 
          }, { status: 409 })
        }

        const nextSecret = await saveAuctionProxyLeader(auctionId, auction.seller_id, secret, nextProxyLeader)

        // Record leader's max push and challenger's winning bid
        await supabaseAdmin.from('auction_bids').insert([
          {
            auction_id: auctionId,
            bidder_id: leaderId,
            amount: leaderMax
          },
          {
            auction_id: auctionId,
            bidder_id: user.id,
            amount: winningVisibleBid
          }
        ])

        // PREVIOUS LEADER IS OUTBID! Notify via platform message & email
        try {
          const outbidMsg = `⚡ ¡Has sido superado en la subasta de "${auction.card_name}"! Tu puja máxima automática de ${leaderMax.toFixed(2).replace('.', ',')} € fue superada. La puja más alta actual es de ${winningVisibleBid.toFixed(2).replace('.', ',')} €.${antiSnipingTriggered ? ' Reloj ampliado +2 min.' : ''} ¡Pisa fuerte y recupera la carta!: /es/${auction.game}/subasta/${auction.id}`
          await supabaseAdmin.from('messages').insert({
            sender_id: user.id,
            receiver_id: leaderId,
            content: outbidMsg,
            is_read: false
          })
        } catch (e) {
          console.warn('Could not insert outbid message:', e)
        }

        notifyOutbidUser(leaderId, {
          id: auction.id,
          card_name: auction.card_name,
          image_url: auction.image_url,
          current_bid: winningVisibleBid,
          game: auction.game,
          ends_at: newEndsAt
        })

        return NextResponse.json({
          success: true,
          auction: maskAuctionForClient(updatedAuction, nextSecret, user.id, true),
          antiSnipingTriggered,
          isProxy: isProxyBid,
          message: isProxyBid
            ? `¡Vas ganando con ${winningVisibleBid.toFixed(2).replace('.', ',')} €! Tu puja máxima (${targetAmount.toFixed(2).replace('.', ',')} €) te defenderá automáticamente.`
            : `¡Puja registrada con éxito de ${winningVisibleBid.toFixed(2).replace('.', ',')} €!`
        })
      }
    }

    // CASE 2: NO ACTIVE PROXY LEADER
    let finalVisibleBid = targetAmount
    let nextProxyLeader = null
    if (isProxyBid) {
      // Advance visible bid up to reserve_price (or targetAmount if lower) when a reserve is active
      finalVisibleBid = (reserveAmount > 0 && minRequired < reserveAmount)
        ? Math.min(targetAmount, reserveAmount)
        : minRequired
      nextProxyLeader = {
        bidder_id: user.id,
        max_bid: targetAmount
      }
    }

    // Update auction FIRST with optimistic concurrency guard
    const { data: updatedAuction, error: updateErr } = await supabaseAdmin
      .from('auctions')
      .update({
        current_bid: finalVisibleBid,
        current_bidder_id: user.id,
        extra_images: extraImagesData,
        total_bids: (auction.total_bids || 0) + 1,
        ends_at: newEndsAt,
        updated_at: new Date().toISOString()
      })
      .eq('id', auctionId)
      .eq('current_bid', auction.current_bid)
      .eq('total_bids', auction.total_bids || 0)
      .eq('status', 'active')
      .select('*')
      .maybeSingle()

    if (updateErr || !updatedAuction) {
      return NextResponse.json({ 
        error: 'La subasta ha recibido una puja simultánea de otro participante. Por favor, inténtalo de nuevo.' 
      }, { status: 409 })
    }

    const nextSecret = (nextProxyLeader || secret?.proxy_leader)
      ? await saveAuctionProxyLeader(auctionId, auction.seller_id, secret, nextProxyLeader)
      : secret

    // Insert bid into auction_bids after winning concurrency lock
    await supabaseAdmin
      .from('auction_bids')
      .insert({
        auction_id: auctionId,
        bidder_id: user.id,
        amount: finalVisibleBid
      })

    // Notify previous manual bidder if outbid
    if (previousBidderId && previousBidderId !== user.id) {
      try {
        const outbidMsg = `⚡ ¡Has sido superado en la subasta de "${auction.card_name}"! La nueva puja más alta es de ${finalVisibleBid.toFixed(2).replace('.', ',')} €.${antiSnipingTriggered ? ' Reloj ampliado +2 min (Anti-Sniping).' : ''} ¡Pisa fuerte y vuelve a pujar!: /es/${auction.game}/subasta/${auction.id}`
        await supabaseAdmin.from('messages').insert({
          sender_id: user.id,
          receiver_id: previousBidderId,
          content: outbidMsg,
          is_read: false
        })
      } catch (err) {
        console.warn('Could not notify outbid bidder:', err)
      }

      notifyOutbidUser(previousBidderId, {
        id: auction.id,
        card_name: auction.card_name,
        image_url: auction.image_url,
        current_bid: finalVisibleBid,
        game: auction.game,
        ends_at: newEndsAt
      })
    }

    return NextResponse.json({
      success: true,
      auction: maskAuctionForClient(updatedAuction, nextSecret, user.id, true),
      antiSnipingTriggered,
      isProxy: isProxyBid,
      message: isProxyBid
        ? `¡Vas ganando con ${finalVisibleBid.toFixed(2).replace('.', ',')} €! Tu puja máxima automática de ${targetAmount.toFixed(2).replace('.', ',')} € protegerá tu oferta.`
        : antiSnipingTriggered 
          ? `¡Puja exitosa! Reloj ampliado +2 minutos por protección Anti-Sniping.` 
          : `¡Puja registrada con éxito de ${finalVisibleBid.toFixed(2).replace('.', ',')} €!`
    })
  } catch (error: any) {
    console.error('Error in POST /api/auctions/bid:', error)
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
  }
}

import { encodeGradingInNotes } from '@/lib/grading'
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { settleAuction } from '@/lib/auctionSettlement'
import { getAuctionSecretsMap, maskAuctionForClient } from '@/lib/auction-helpers'

const MAX_AUCTION_PRICE_EUR = 500000;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const game = searchParams.get('game') || 'all'
    const status = searchParams.get('status') || 'active'
    const sort = searchParams.get('sort') || 'ending_soon'
    const query = searchParams.get('q') || ''

    // Auto-mark expired auctions as 'ended' and adjudicate winners
    const nowIso = new Date().toISOString()
    try {
      const { data: expiredAuctions } = await supabaseAdmin
        .from('auctions')
        .select('*')
        .eq('status', 'active')
        .lt('ends_at', nowIso)

      if (expiredAuctions && expiredAuctions.length > 0) {
        const expiredSecrets = await getAuctionSecretsMap(expiredAuctions.map((a: any) => a.id))
        for (const a of expiredAuctions) {
          await settleAuction({
            ...a,
            reserve_price: expiredSecrets.get(a.id)?.reserve_price ?? null
          })
        }
      }
    } catch (e) {
      // Table might not exist yet if migration pending
    }

    let queryBuilder = supabaseAdmin
      .from('auctions')
      .select(`
        *,
        seller:profiles!seller_id(id, username, country, rating, sales_count),
        current_bidder:profiles!current_bidder_id(id, username, country)
      `)

    if (status !== 'all') {
      queryBuilder = queryBuilder.eq('status', status)
    }

    if (game !== 'all') {
      queryBuilder = queryBuilder.eq('game', game)
    }

    if (query) {
      const safeQuery = query.replace(/[,()]/g, ' ').trim()
      if (safeQuery) {
        queryBuilder = queryBuilder.or(`title.ilike.%${safeQuery}%,card_name.ilike.%${safeQuery}%,set_name.ilike.%${safeQuery}%`)
      }
    }

    if (sort === 'ending_soon') {
      queryBuilder = queryBuilder.order('ends_at', { ascending: true })
    } else if (sort === 'popular') {
      queryBuilder = queryBuilder.order('total_bids', { ascending: false })
    } else if (sort === 'newest') {
      queryBuilder = queryBuilder.order('created_at', { ascending: false })
    } else if (sort === 'price_asc') {
      queryBuilder = queryBuilder.order('current_bid', { ascending: true })
    } else if (sort === 'price_desc') {
      queryBuilder = queryBuilder.order('current_bid', { ascending: false })
    }

    const { data: auctions, error } = await queryBuilder.limit(100)

    if (error && error.message?.includes('does not exist')) {
      return NextResponse.json({ auctions: [], migrationRequired: true })
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const secretsMap = await getAuctionSecretsMap((auctions || []).map((a: any) => a.id))

    const formattedAuctions = (auctions || []).map((a: any) => {
      const buyNow = typeof a.extra_images === 'object' && !Array.isArray(a.extra_images)
        ? a.extra_images?.buy_now_price
        : (Array.isArray(a.extra_images) ? a.extra_images.find((x: any) => x?.buy_now_price)?.buy_now_price : null);
      const activeBuyNow = buyNow && Number(a.current_bid) < Number(buyNow) ? Number(buyNow) : null;

      return {
        ...maskAuctionForClient(a, secretsMap.get(a.id), null, false),
        buy_now_price: activeBuyNow
      }
    })

    return NextResponse.json({ auctions: formattedAuctions })
  } catch (error: any) {
    console.error('Error in GET /api/auctions:', error)
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
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

    // Verificar que el usuario tenga cuenta de vendedor verificada (KYC) y no esté de vacaciones
    const { data: sellerProfile } = await supabaseAdmin
      .from('profiles')
      .select('is_authorized_seller, verification_status, on_vacation')
      .eq('id', user.id)
      .single()

    if (!sellerProfile || sellerProfile.is_authorized_seller !== true || !['verified', 'approved'].includes(sellerProfile.verification_status)) {
      return NextResponse.json({ error: 'Debes tener una cuenta de vendedor verificada (KYC) para crear subastas.' }, { status: 403 })
    }

    if (sellerProfile.on_vacation) {
      return NextResponse.json({ error: 'No puedes crear subastas mientras tu cuenta esté en modo vacaciones.' }, { status: 400 })
    }

    const body = await req.json()
    const {
      game = 'yugioh',
      title,
      card_name,
      set_name,
      rarity,
      condition = 'Near Mint',
      language = 'Español',
      image_url,
      extra_images = [],
      description,
      starting_price = 1.00,
      reserve_price,
      buy_now_price,
      min_bid_increment = 1.00,
      duration_hours = 72 // Default 3 days
    } = body

    if (!card_name || !title) {
      return NextResponse.json({ error: 'El nombre de la carta y el título son obligatorios' }, { status: 400 })
    }

    const startPrice = Math.round(Number(starting_price) * 100) / 100
    if (!Number.isFinite(startPrice) || startPrice < 0.5 || startPrice > MAX_AUCTION_PRICE_EUR) {
      return NextResponse.json({ error: `El precio inicial debe estar entre 0,50 € y ${MAX_AUCTION_PRICE_EUR.toLocaleString('es-ES')} €` }, { status: 400 })
    }

    const minIncrement = Math.round(Number(min_bid_increment) * 100) / 100
    if (!Number.isFinite(minIncrement) || minIncrement < 0.5 || minIncrement > 10000) {
      return NextResponse.json({ error: 'El incremento mínimo de puja debe estar entre 0,50 € y 10.000 €' }, { status: 400 })
    }

    const durationH = Number(duration_hours)
    if (!Number.isFinite(durationH) || durationH < 1 || durationH > 336) { // 1 hour to 14 days
      return NextResponse.json({ error: 'La duración debe ser entre 1 hora y 14 días' }, { status: 400 })
    }

    const parsedReserve = reserve_price ? Math.round(Number(reserve_price) * 100) / 100 : null
    if (parsedReserve !== null) {
      if (!Number.isFinite(parsedReserve) || parsedReserve < startPrice || parsedReserve > MAX_AUCTION_PRICE_EUR) {
        return NextResponse.json({ error: 'El precio de reserva debe ser válido y mayor o igual al precio inicial' }, { status: 400 })
      }
    }

    const parsedBuyNow = buy_now_price ? Math.round(Number(buy_now_price) * 100) / 100 : null
    if (parsedBuyNow !== null) {
      if (!Number.isFinite(parsedBuyNow) || parsedBuyNow <= startPrice || parsedBuyNow > MAX_AUCTION_PRICE_EUR) {
        return NextResponse.json({ error: 'El precio de Cómpralo Ya debe ser válido y superior al precio inicial' }, { status: 400 })
      }
      if (parsedReserve !== null && parsedBuyNow < parsedReserve) {
        return NextResponse.json({ error: 'El precio de Cómpralo Ya no puede ser inferior al precio de reserva' }, { status: 400 })
      }
    }

    const rawPhotos = typeof extra_images === 'object' && extra_images !== null && !Array.isArray(extra_images)
      ? (Array.isArray(extra_images.photos) ? extra_images.photos : [])
      : (Array.isArray(extra_images) ? extra_images : [])

    let finalDescription = description || ''
    if (body.grading && body.grading.isGraded) {
      finalDescription = encodeGradingInNotes(finalDescription, body.grading)
    }

    const extraImagesPayload = {
      photos: rawPhotos.filter((u: any) => typeof u === 'string').slice(0, 10),
      buy_now_price: parsedBuyNow,
      grading: body.grading || null
    }

    const now = new Date()
    let endsAt: string
    if (body.ends_at) {
      const parsed = new Date(body.ends_at)
      if (isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime() + 1800000) {
        return NextResponse.json({ error: 'La fecha de finalización debe ser al menos 30 minutos en el futuro' }, { status: 400 })
      }
      endsAt = parsed.toISOString()
    } else {
      endsAt = new Date(now.getTime() + durationH * 60 * 60 * 1000).toISOString()
    }

    const { data: newAuction, error: insertError } = await supabaseAdmin
      .from('auctions')
      .insert({
        game,
        title,
        card_name,
        set_name: set_name || '',
        rarity: rarity || '',
        condition,
        language,
        image_url: image_url || '',
        extra_images: extraImagesPayload,
        description: finalDescription?.trim() || null,
        seller_id: user.id,
        starting_price: startPrice,
        current_bid: startPrice,
        min_bid_increment: minIncrement,
        total_bids: 0,
        status: 'active',
        starts_at: now.toISOString(),
        ends_at: endsAt,
        anti_sniping_seconds: 120
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('Error creating auction:', insertError)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    let createdSecret = null
    if (parsedReserve !== null) {
      const { data: secretRow, error: secretErr } = await supabaseAdmin
        .from('auction_secrets')
        .insert({
          auction_id: newAuction.id,
          seller_id: user.id,
          reserve_price: parsedReserve,
          proxy_leader: null
        })
        .select('auction_id, seller_id, reserve_price, proxy_leader')
        .single()

      if (secretErr) {
        await supabaseAdmin.from('auctions').delete().eq('id', newAuction.id)
        return NextResponse.json({ error: 'Error configurando el precio de reserva confidencial.' }, { status: 500 })
      }
      createdSecret = secretRow
    }

    return NextResponse.json({
      success: true,
      auction: {
        ...maskAuctionForClient(newAuction, createdSecret, user.id, true),
        buy_now_price: parsedBuyNow
      }
    })
  } catch (error: any) {
    console.error('Error in POST /api/auctions:', error)
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
  }
}

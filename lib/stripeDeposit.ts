import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { adjustUserBalance } from '@/lib/balance'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16' as any,
})

// Configuración de métodos de pago del panel de Stripe (configurable por entorno en producción)
export const STRIPE_PAYMENT_METHOD_CONFIGURATION =
  process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION || ''

// Stripe solo emite IBAN virtuales EUR en estos países
const EU_BANK_TRANSFER_COUNTRIES = new Set(['DE', 'FR', 'IE', 'NL'])

export function pickEuBankTransferCountry(userCountry?: string): 'DE' | 'FR' | 'IE' | 'NL' {
  const c = (userCountry || '').toUpperCase()
  return (EU_BANK_TRANSFER_COUNTRIES.has(c) ? c : 'IE') as 'DE' | 'FR' | 'IE' | 'NL'
}

/**
 * Busca el Customer de Stripe del usuario (por ID guardado, email + metadata.userId, o Stripe Search).
 * Necesario para el IBAN virtual (customer_balance): cada usuario conserva siempre el mismo IBAN.
 */
export async function findStripeCustomer(
  userId: string,
  email?: string | null,
  storedCustomerId?: string | null
): Promise<Stripe.Customer | null> {
  if (storedCustomerId) {
    try {
      const retrieved = await stripe.customers.retrieve(storedCustomerId)
      if (!('deleted' in retrieved && retrieved.deleted)) {
        return retrieved as Stripe.Customer
      }
    } catch {}
  }
  if (email) {
    const list = await stripe.customers.list({ email, limit: 20 })
    const match = list.data.find(c => c.metadata?.userId === userId)
    if (match) return match
  }
  try {
    const res = await stripe.customers.search({ query: `metadata['userId']:'${userId}'`, limit: 1 })
    if (res.data[0]) return res.data[0]
  } catch {}
  return null
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email?: string | null,
  name?: string | null,
  storedCustomerId?: string | null
): Promise<Stripe.Customer> {
  const existing = await findStripeCustomer(userId, email, storedCustomerId)
  if (existing) {
    if (!storedCustomerId) {
      // Guardar en profiles si la columna stripe_customer_id existe (falla en silencio si aún no se migró)
      await supabaseAdmin.from('profiles').update({ stripe_customer_id: existing.id }).eq('id', userId)
    }
    return existing
  }

  const normalizedEmail = (email || '').trim().toLowerCase()
  const created = await stripe.customers.create(
    {
      email: email || undefined,
      metadata: { userId, platform: 'EuropeTCG' },
    },
    { idempotencyKey: `etcg_cust_${userId}_${normalizedEmail || 'noemail'}` }
  )

  if (name && !created.name) {
    try {
      await stripe.customers.update(created.id, { name })
    } catch {}
  }

  // Persistir en profiles si existe la columna stripe_customer_id (ignora error si no existe)
  await supabaseAdmin.from('profiles').update({ stripe_customer_id: created.id }).eq('id', userId)

  return created
}

async function readCurrentBalance(userId: string): Promise<number | undefined> {
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', userId)
      .maybeSingle()
    if (data && data.balance !== null && data.balance !== undefined) {
      return Number(data.balance)
    }
  } catch {}
  return undefined
}

export type CreditResult =
  | { status: 'credited'; amountAdded: number; newBalance: number; feeAdjusted: boolean }
  | { status: 'already_processed'; amountAdded: number; newBalance?: number }
  | { status: 'pending'; method: string }
  | { status: 'invalid'; error: string; httpStatus: number }
  | { status: 'error'; error: string }

/**
 * Acredita en el monedero una sesión de Checkout de recarga ya pagada.
 * Idempotente: puede llamarse desde el webhook (completed / async_payment_succeeded) y desde verify-deposit.
 */
export async function creditStripeDepositSession(sessionId: string, expectedUserId?: string): Promise<CreditResult> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge.balance_transaction'],
  })

  const userId = session.metadata?.userId
  const expectedNetAmount = parseFloat(session.metadata?.netAmount || '0')
  const expectedFeeAmount = parseFloat(session.metadata?.feeAmount || '0')
  const method = session.metadata?.depositMethod || 'card'

  if (!userId || expectedNetAmount <= 0) {
    return { status: 'invalid', error: 'Metadatos de recarga inválidos.', httpStatus: 400 }
  }
  if (expectedUserId && expectedUserId !== userId) {
    return { status: 'invalid', error: 'El usuario no coincide con el pago registrado.', httpStatus: 403 }
  }

  if (session.payment_status !== 'paid') {
    // Transferencia SEPA: el usuario ya tiene las instrucciones, el saldo llegará con async_payment_succeeded
    if (session.status === 'complete' && session.payment_status === 'unpaid') {
      return { status: 'pending', method }
    }
    return { status: 'invalid', error: 'El pago no ha sido completado en Stripe.', httpStatus: 400 }
  }

  const expectedCents = Math.round((expectedNetAmount + expectedFeeAmount) * 100)
  if (session.amount_total && session.amount_total < expectedCents) {
    return { status: 'invalid', error: 'Monto total pagado no coincide con el esperado.', httpStatus: 400 }
  }

  // Blindaje: si la comisión real de Stripe supera la prevista, se acredita el neto real liquidado
  let finalNetAmount = expectedNetAmount
  let finalFeeAmount = expectedFeeAmount
  let feeAdjusted = false
  try {
    const pi = session.payment_intent as Stripe.PaymentIntent | null
    const latestCharge = pi?.latest_charge as Stripe.Charge | null
    const balanceTx = latestCharge?.balance_transaction as Stripe.BalanceTransaction | null
    if (balanceTx && typeof balanceTx.fee === 'number') {
      const realStripeFee = Math.round(balanceTx.fee) / 100
      const realStripeNet = Math.round(balanceTx.net) / 100
      // Margen de 1 céntimo por redondeo bancario antes de activar ajuste internacional
      if (realStripeFee > expectedFeeAmount + 0.01) {
        finalFeeAmount = realStripeFee
        feeAdjusted = true
        finalNetAmount = Math.min(expectedNetAmount, realStripeNet)
      }
    }
  } catch (btErr) {
    console.warn('creditStripeDepositSession: no se pudo leer balance_transaction:', btErr)
  }

  const transactionRef = `Stripe_Depósito_${sessionId}`
  const { data: existingTx } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('description', transactionRef)
    .maybeSingle()
  if (existingTx) {
    const newBalance = await readCurrentBalance(userId)
    return { status: 'already_processed', amountAdded: finalNetAmount, newBalance }
  }

  const { data: insertedTx, error: txInsertErr } = await supabaseAdmin
    .from('transactions')
    .insert({ user_id: userId, type: 'Ingreso', amount: finalNetAmount, description: transactionRef })
    .select('id')
    .single()
  if (txInsertErr || !insertedTx) {
    // 23505 = unique_violation sobre idx_transactions_gateway_deposit_unique (idempotencia real)
    if (txInsertErr?.code === '23505') {
      const newBalance = await readCurrentBalance(userId)
      return { status: 'already_processed', amountAdded: finalNetAmount, newBalance }
    }
    return {
      status: 'error',
      error: txInsertErr?.message || 'Error registrando transacción de recarga en base de datos',
    }
  }

  // Control secundario de ganador único por si algún entorno careciera del índice único
  const { data: allMatchingTxs } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('description', transactionRef)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (allMatchingTxs && allMatchingTxs.length > 1 && allMatchingTxs[0].id !== insertedTx.id) {
    await supabaseAdmin.from('transactions').delete().eq('id', insertedTx.id)
    const newBalance = await readCurrentBalance(userId)
    return { status: 'already_processed', amountAdded: finalNetAmount, newBalance }
  }

  const balanceRes = await adjustUserBalance(userId, finalNetAmount)
  if (!balanceRes.success) {
    await supabaseAdmin.from('transactions').delete().eq('id', insertedTx.id)
    return { status: 'error', error: balanceRes.error || 'Error ajustando saldo' }
  }

  if (finalFeeAmount > 0) {
    const methodLabel = method === 'bank_transfer' ? 'Transferencia SEPA' : feeAdjusted ? 'Internacional/No-EEE' : 'Tarjeta'
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'Tasa',
      amount: -finalFeeAmount,
      description: `Comisión de pasarela Stripe (${methodLabel})_${sessionId.slice(-6)}`,
    })
  }

  // Si la recarga se inició desde el carrito de compra (autoCheckout === 'true'),
  // ejecutamos automáticamente el checkout en el servidor en cuanto entra el dinero (especialmente clave en Transferencias SEPA asíncronas)
  let autoCheckoutExecuted = false
  if (session.metadata?.autoCheckout === 'true' && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      let items: Array<{
        id: string
        listing_id: string
        quantity: number
        seller_name: string
        set_code?: string
        is_bundle?: boolean
      }> = []

      if (session.metadata?.coItems) {
        try {
          const parsed = JSON.parse(session.metadata.coItems)
          if (Array.isArray(parsed)) {
            items = parsed
              .map((it: any) => {
                const rawId = String(it.l || it.i || it.listing_id || it.id || '').trim()
                const isBundleFlag = Boolean(it.b || it.is_bundle || it.sc === 'LOTE' || it.set_code === 'LOTE')
                const setCode = String(it.sc || it.set_code || (isBundleFlag ? 'LOTE' : '')).trim()
                return {
                  id: setCode === 'SUBASTA' && !rawId.startsWith('auction_') ? `auction_${rawId}` : rawId,
                  listing_id: rawId,
                  quantity: Number(it.q || it.quantity || 1),
                  seller_name: String(it.s || it.seller_name || '').trim(),
                  set_code: setCode,
                  is_bundle: isBundleFlag,
                }
              })
              .filter(it => Boolean(it.listing_id && it.seller_name))
          }
        } catch {}
      }

      // Fallback a cart_items de base de datos si el carrito superó 490 chars en metadata
      if (items.length === 0) {
        const { data: dbCart } = await supabaseAdmin
          .from('cart_items')
          .select('listing_id, bundle_id, quantity')
          .eq('user_id', userId)
        if (dbCart && dbCart.length > 0) {
          const listingIds = dbCart.map((c: any) => c.listing_id).filter(Boolean)
          const bundleIds = dbCart.map((c: any) => c.bundle_id).filter(Boolean)
          const [listingsRes, bundlesRes] = await Promise.all([
            listingIds.length > 0
              ? supabaseAdmin.from('listings').select('id, seller_id').in('id', listingIds)
              : Promise.resolve({ data: [] as any[] }),
            bundleIds.length > 0
              ? supabaseAdmin.from('bundles').select('id, seller_id').in('id', bundleIds)
              : Promise.resolve({ data: [] as any[] }),
          ])
          const allSellerIds = Array.from(
            new Set([
              ...(listingsRes.data || []).map((l: any) => l.seller_id),
              ...(bundlesRes.data || []).map((b: any) => b.seller_id),
            ].filter(Boolean))
          )
          const { data: sellersProf } = allSellerIds.length > 0
            ? await supabaseAdmin.from('profiles').select('id, username').in('id', allSellerIds)
            : { data: [] as any[] }
          const sellerUsernameById = new Map((sellersProf || []).map((p: any) => [String(p.id), String(p.username)]))
          const listingSellerMap = new Map((listingsRes.data || []).map((l: any) => [String(l.id), sellerUsernameById.get(String(l.seller_id)) || '']))
          const bundleSellerMap = new Map((bundlesRes.data || []).map((b: any) => [String(b.id), sellerUsernameById.get(String(b.seller_id)) || '']))

          items = dbCart
            .map((c: any) => {
              if (c.bundle_id) {
                const sName = bundleSellerMap.get(String(c.bundle_id)) || ''
                return {
                  id: String(c.bundle_id),
                  listing_id: String(c.bundle_id),
                  quantity: 1,
                  seller_name: sName,
                  set_code: 'LOTE',
                  is_bundle: true,
                }
              }
              const sName = listingSellerMap.get(String(c.listing_id)) || ''
              return {
                id: String(c.listing_id),
                listing_id: String(c.listing_id),
                quantity: Number(c.quantity || 1),
                seller_name: sName,
              }
            })
            .filter(it => Boolean(it.listing_id && it.seller_name))
        }
      }

      if (items.length > 0) {
        const uniqueSellers = Array.from(new Set(items.map(it => it.seller_name).filter(Boolean)))
        let shippingMethods: Record<string, string> = {}
        let shippingCosts: Record<string, number> = {}
        let freightCollectAgencies: Record<string, string> = {}
        try { if (session.metadata?.coMethods) shippingMethods = JSON.parse(session.metadata.coMethods) } catch {}
        try { if (session.metadata?.coCosts) shippingCosts = JSON.parse(session.metadata.coCosts) } catch {}
        try { if (session.metadata?.coAgencies) freightCollectAgencies = JSON.parse(session.metadata.coAgencies) } catch {}

        // En producción este paso invoca el motor interno de checkout atómico (idempotencyKey: `stripe_sess_${sessionId}`).
        // En este repositorio showcase se expone el punto de extensión vía endpoint interno o hook desacoplado.
        const internalCheckoutUrl = process.env.INTERNAL_AUTO_CHECKOUT_URL
        if (internalCheckoutUrl && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          const coRes = await fetch(internalCheckoutUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-service-key': process.env.SUPABASE_SERVICE_ROLE_KEY,
            },
            body: JSON.stringify({
              userId,
              items,
              sellers: uniqueSellers,
              shippingMethods,
              shippingCosts,
              freightCollectAgencies,
              idempotencyKey: `stripe_sess_${sessionId}`,
            }),
          })
          if (coRes.ok) {
            autoCheckoutExecuted = true
            await supabaseAdmin.from('cart_items').delete().eq('user_id', userId)
          } else {
            const errJson = await coRes.json().catch(() => ({}))
            console.warn('AutoCheckout post-deposit warning:', errJson)
          }
        } else {
          void uniqueSellers
          void shippingMethods
          void shippingCosts
          void freightCollectAgencies
        }
      }
    } catch (coErr) {
      console.error('Error ejecutando autoCheckout en creditStripeDepositSession:', coErr)
    }
  }

  // Si fue transferencia bancaria SEPA y no se autoejecutó compra (o fue recarga directa de monedero), avisar por email al usuario
  if (method === 'bank_transfer' && !autoCheckoutExecuted) {
    try {
      const { data: uAuth } = await supabaseAdmin.auth.admin.getUserById(userId)
      const userEmail = uAuth?.user?.email
      if (userEmail) {
        const { sendPlatformEmail, SITE_URL } = await import('@/lib/mailer')
        await sendPlatformEmail({
          fromName: 'EuropeTCG Pagos',
          to: userEmail,
          subject: `✅ Transferencia SEPA recibida: +${finalNetAmount.toFixed(2)} € acreditados en tu monedero`,
          html: `
            <div style="font-family: sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px;">
              <h2 style="color: #059669; margin-top: 0;">¡Transferencia SEPA acreditada con éxito!</h2>
              <p>Hola,</p>
              <p>Hemos recibido tu transferencia bancaria SEPA y hemos acreditado automáticamente <strong>+${finalNetAmount.toFixed(2)} €</strong> netos en tu monedero de <strong>EuropeTCG</strong>.</p>
              <p>Tu nuevo saldo disponible es de <strong>${Number(balanceRes.newBalance ?? finalNetAmount).toFixed(2)} €</strong>.</p>
              <div style="text-align: center; margin-top: 24px;">
                <a href="${SITE_URL}/es/cart" style="display: inline-block; background: #0f172a; color: #ffd23f; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 10px;">Ir a mi Carrito / Monedero</a>
              </div>
            </div>
          `,
        })
      }
    } catch {}
  }

  return { status: 'credited', amountAdded: finalNetAmount, newBalance: balanceRes.newBalance, feeAdjusted }
}

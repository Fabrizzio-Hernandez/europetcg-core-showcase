import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { adjustUserBalance } from '@/lib/balance'
import { rateLimit } from '@/lib/rate-limit'
import { sendPlatformEmail, getAdminNotificationEmail, SITE_URL } from '@/lib/mailer'

function escapeHtml(str?: string | null): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function calculateAmlWithdrawalBreakdown(userId: string, currentBalance: number) {
  const [{ data: depositTxs }, { data: validBuyerOrders }, { data: refundTxs }] = await Promise.all([
    supabaseAdmin
      .from('transactions')
      .select('amount, type, description')
      .eq('user_id', userId)
      .in('type', ['Ingreso', 'Depósito']),
    supabaseAdmin
      .from('orders')
      .select('total_price, status')
      .eq('buyer_id', userId)
      .in('status', ['pagado', 'enviado', 'entregado', 'recibido', 'completado']),
    supabaseAdmin
      .from('transactions')
      .select('amount, type, description')
      .eq('user_id', userId)
      .eq('type', 'Abone_Parcial')
  ])

  const totalGatewayDeposits = (depositTxs || [])
    .filter(tx => {
      const desc = String(tx.description || '')
      const type = String(tx.type || '')
      return (
        (type === 'Ingreso' && (desc.startsWith('Stripe_Depósito_') || desc.startsWith('PayPal_Depósito_'))) ||
        (type === 'Depósito' && desc.startsWith('Depósito por transferencia SEPA aprobado'))
      )
    })
    .reduce((sum, tx) => sum + Math.max(0, Number(tx.amount || 0)), 0)

  const grossValidPurchases = (validBuyerOrders || []).reduce((sum, ord) => sum + Math.max(0, Number(ord.total_price || 0)), 0)
  // Descontar reembolsos parciales o por disputas de compras para que no computen como gasto neto de pasarela
  const totalOrderRefunds = (refundTxs || [])
    .filter(tx => !String(tx.description || '').includes('retiro'))
    .reduce((sum, tx) => sum + Math.max(0, Number(tx.amount || 0)), 0)
  const netValidPurchases = Math.max(0, Math.round((grossValidPurchases - totalOrderRefunds) * 100) / 100)

  const rawUnspentDeposits = Math.max(0, Math.round((totalGatewayDeposits - netValidPurchases) * 100) / 100)
  const unspentDepositBalance = Math.min(currentBalance, rawUnspentDeposits)
  const withdrawableEarnings = Math.max(0, Math.round((currentBalance - unspentDepositBalance) * 100) / 100)

  return {
    currentBalance: Math.round(currentBalance * 100) / 100,
    withdrawableEarnings,
    unspentDepositBalance,
    totalGatewayDeposits: Math.round(totalGatewayDeposits * 100) / 100,
    netValidPurchases
  }
}

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const token = authHeader.replace('Bearer ', '').trim()
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', user.id)
      .maybeSingle()

    const currentBalance = Number(profile?.balance || 0)
    const breakdown = await calculateAmlWithdrawalBreakdown(user.id, currentBalance)
    return NextResponse.json(breakdown)
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  let userId = ''
  let amount = 0
  let method = ''
  let destinationAccount = ''
  let balanceDeducted = false

  try {
    // 0. Rate Limiting
    const ip = req.headers.get('x-forwarded-for') || 'unknown'
    const rl = rateLimit(`withdraw_${ip}`, 5, 60000)
    if (!rl.success) {
      return NextResponse.json({ error: 'Demasiadas solicitudes de retiro seguidas. Espera un minuto.' }, { status: 429 })
    }

    // 1. Recibir y tipar estrictamente los datos de la petición
    const body = await req.json()
    userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    amount = Math.round(Number(body.amount) * 100) / 100
    method = typeof body.method === 'string' ? body.method.trim() : ''
    destinationAccount = typeof body.destinationAccount === 'string' ? body.destinationAccount.trim() : ''

    if (!userId || !Number.isFinite(amount) || amount <= 0 || !method || !destinationAccount) {
      return NextResponse.json({ error: 'Faltan datos requeridos o formato inválido' }, { status: 400 })
    }

    // AUTENTICACIÓN ESTRICTA
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const token = authHeader.replace('Bearer ', '').trim()
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user || user.id !== userId) {
      return NextResponse.json({ error: 'Invalid token or user mismatch' }, { status: 401 })
    }

    if (amount < 5) {
      return NextResponse.json({ error: 'El importe mínimo de retiro es de 5,00 €' }, { status: 400 })
    }

    // 2. Verificar el saldo y estado de cuenta en la Base de Datos
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('username, full_name, balance, tax_id, national_id_number, user_type, verification_status, is_authorized_seller')
      .eq('id', userId)
      .single()

    if (profileError || !profile) {
      return NextResponse.json({ error: 'Usuario no encontrado' }, { status: 404 })
    }

    if (profile.verification_status === 'rejected') {
      return NextResponse.json({ error: 'Tu cuenta tiene la verificación bloqueada o rechazada. Contacta con soporte.' }, { status: 403 })
    }

    const currentBalance = Number(profile.balance || 0)
    if (currentBalance < amount) {
      return NextResponse.json({ error: 'Saldo insuficiente' }, { status: 400 })
    }

    // 2.b ESCUDO FINANCIERO ANTIBLANQUEO (AML) Y ANTI-CASHOUT DE RECARGAS:
    // Impedir que alguien recargue saldo con tarjeta/PayPal/transferencia SEPA y lo retire por transferencia bancaria SEPA sin haber vendido.
    // Solo se contabilizan pedidos efectivamente PAGADOS (excluyendo pendientes de pago, cancelados, reembolsados y extraviados).
    const { withdrawableEarnings, unspentDepositBalance } = await calculateAmlWithdrawalBreakdown(userId, currentBalance)

    if (amount > withdrawableEarnings + 0.02) {
      return NextResponse.json({ 
        error: `Por normativa bancaria europea antiblanqueo (AML) y prevención de fraude con tarjetas, las transferencias SEPA están reservadas exclusivamente para retirar ganancias procedentes de ventas (${withdrawableEarnings.toFixed(2)} € disponibles para retiro SEPA). El saldo recargado no utilizado en compras (${unspentDepositBalance.toFixed(2)} €) no puede extraerse a una cuenta bancaria vía SEPA; si deseas anular una recarga no utilizada, solicita su devolución al método de pago original desde Soporte.` 
      }, { status: 400 })
    }

    // 2.c VERIFICACIÓN REGULATORIA DAC7 (Directiva UE 2021/514 / RD 117/2024):
    // Si el vendedor alcanza 30 ventas o 2.000 € brutos en el año natural, debe registrar NIF/NIE fiscal
    const currentYear = new Date().getFullYear()
    const startOfYear = `${currentYear}-01-01T00:00:00.000Z`

    const { data: annualSellerOrders, error: dac7Error } = await supabaseAdmin
      .from('orders')
      .select('total_price')
      .eq('seller_id', userId)
      .gte('created_at', startOfYear)
      .in('status', ['pagado', 'enviado', 'entregado', 'recibido', 'completado'])

    if (!dac7Error && annualSellerOrders) {
      const annualSalesCount = annualSellerOrders.length
      const annualGrossVolume = annualSellerOrders.reduce((acc, o) => acc + Number(o.total_price || 0), 0)

      const hasTaxId = Boolean(profile.tax_id || profile.national_id_number)
      if ((annualSalesCount >= 30 || annualGrossVolume >= 2000) && !hasTaxId) {
        return NextResponse.json({
          error: `Conforme a la Directiva Europea DAC7 (Directiva UE 2021/514) y el Real Decreto 117/2024, has alcanzado el umbral legal anual de reporte tributario (${annualSalesCount} operaciones / ${annualGrossVolume.toFixed(2)} € brutos acumulados). Para procesar transferencias bancarias SEPA a tu cuenta, debes registrar y verificar tu NIF/NIE o Identificador Fiscal en tu Perfil.`
        }, { status: 403 })
      }
    }

    // 3. RESTAR EL SALDO INMEDIATAMENTE VÍA RPC ATÓMICO (SELECT ... FOR UPDATE)
    const deductRes = await adjustUserBalance(userId, -amount)
    if (!deductRes.success) {
      const isInsufficient = deductRes.error?.toLowerCase().includes('insuficiente')
      return NextResponse.json(
        { error: deductRes.error || 'Operación concurrente detectada. Inténtalo de nuevo.' },
        { status: isInsufficient ? 400 : 409 }
      )
    }

    balanceDeducted = true

    // 4. REGISTRAR EN WITHDRAWAL_REQUESTS PRIMERO PARA OBTENER EL ID DE REFERENCIA
    const feeAmount = 0.00
    const netAmount = amount
    const payoutMethod = 'sepa'

    const { data: wReq, error: wReqError } = await supabaseAdmin
      .from('withdrawal_requests')
      .insert({
        user_id: userId,
        amount: amount,
        fee: feeAmount,
        net_amount: netAmount,
        payout_method: payoutMethod,
        account_details: destinationAccount,
        status: 'pendiente'
      })
      .select('id')
      .single()

    if (wReqError || !wReq) {
      throw new Error(`Error registrando la solicitud de retiro en el sistema: ${wReqError?.message || 'Unknown error'}`)
    }

    // 5. REGISTRAR LA TRANSACCIÓN CON EL ID DE LA SOLICITUD (Como pendiente)
    const descLabel = `Retiro PENDIENTE vía Transferencia Bancaria SEPA en EUR [ID:${wReq.id}] (Datos: ${destinationAccount})`
    const { error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'Retiro',
        amount: -amount,
        description: descLabel
      })

    if (txError) {
      await supabaseAdmin.from('withdrawal_requests').delete().eq('id', wReq.id)
      throw txError
    }

    // 5.b NOTIFICAR POR EMAIL AL ADMINISTRADOR (PARA EMITIR LA TRANSFERENCIA SEPA MANUAL) Y ACUSE AL VENDEDOR
    try {
      const rawAdminEmail = getAdminNotificationEmail()
      const adminRecipient = rawAdminEmail.toLowerCase().startsWith('no-reply@')
        ? 'soporte@europetcg.eu'
        : rawAdminEmail
      const safeUsername = escapeHtml(profile.username || 'vendedor')
      const safeFullName = escapeHtml(profile.full_name || profile.username || 'Sin nombre')
      const safeEmail = escapeHtml(user.email || 'N/A')
      const safeTaxDoc = escapeHtml(profile.tax_id || profile.national_id_number || 'No registrado')
      const safeDestination = escapeHtml(destinationAccount)
      const formattedEur = amount.toFixed(2).replace('.', ',')

      await Promise.allSettled([
        sendPlatformEmail({
          fromName: 'EuropeTCG Tesorería SEPA',
          to: adminRecipient,
          subject: `🏦 Retiro SEPA pendiente: ${formattedEur} € (@${safeUsername})`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0d0619; color: #ffffff; padding: 24px; border-radius: 12px; border: 1px solid #351f58; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #ffd23f; margin-top: 0;">Nueva Solicitud de Retiro SEPA Manual</h2>
              <p style="color: #e2e8f0; font-size: 14px;">Un vendedor ha solicitado retirar sus ganancias de ventas. El saldo ya ha sido descontado atómicamente de su billetera.</p>
              <div style="background-color: #180d2c; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #351f58; font-size: 14px;">
                <p style="margin: 6px 0;"><strong>ID Solicitud:</strong> <code>#${escapeHtml(String(wReq.id))}</code></p>
                <p style="margin: 6px 0;"><strong>Importe neto a transferir:</strong> <span style="color: #2ee6a6; font-weight: bold; font-size: 16px;">${formattedEur} € EUR</span> (Comisión: 0,00 €)</p>
                <p style="margin: 6px 0;"><strong>Vendedor:</strong> @${safeUsername} — ${safeFullName} (${safeEmail})</p>
                <p style="margin: 6px 0;"><strong>NIF / DNI / CIF:</strong> ${safeTaxDoc}</p>
                <p style="margin: 6px 0;"><strong>Datos Bancarios / IBAN Destino:</strong><br/><code style="display: inline-block; margin-top: 4px; padding: 6px 10px; background: #0d0619; border-radius: 6px; color: #ffd23f; word-break: break-all;">${safeDestination}</code></p>
              </div>
              <div style="text-align: center; margin-top: 22px;">
                <a href="${SITE_URL}/es/admin" style="background-color: #ffd23f; color: #0d0619; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 8px; display: inline-block; text-transform: uppercase; font-size: 13px;">
                  Gestionar y Marcar Pagado en /admin
                </a>
              </div>
            </div>
          `
        }),
        ...(user.email
          ? [
              sendPlatformEmail({
                fromName: 'EuropeTCG Pagos SEPA',
                to: user.email,
                subject: `⏳ Solicitud de retiro SEPA recibida (${formattedEur} €)`,
                html: `
                  <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1e293b;">
                    <h2 style="color: #0f172a;">Solicitud de retiro SEPA registrada</h2>
                    <p>Hemos registrado tu solicitud de retiro por importe de <strong>${formattedEur} € EUR</strong> (comisión <strong>0,00 €</strong>).</p>
                    <p style="background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-family: monospace; font-size: 13px; word-break: break-all;">
                      ${safeDestination}
                    </p>
                    <p style="font-size: 14px; color: #475569;">La transferencia bancaria SEPA se emitirá en un plazo de <strong>24 a 48 horas laborables</strong>. Recibirás otro correo de confirmación en cuanto salga la transferencia.</p>
                    <p style="margin-top: 24px; font-size: 12px; color: #94a3b8;">Referencia interna: #${escapeHtml(String(wReq.id))} · EuropeTCG</p>
                  </div>
                `
              })
            ]
          : [])
      ])
    } catch (mailErr) {
      console.warn('Aviso: no se pudo enviar email de aviso de retiro SEPA:', mailErr)
    }

    // 6. Devolver éxito
    return NextResponse.json({ 
      success: true, 
      message: 'Solicitud de retiro registrada con éxito. La transferencia bancaria SEPA en Euros (€) se emitirá directamente a tu IBAN en 24-48h laborables sin comisión (0,00 €).',
      requestId: wReq.id
    })

  } catch (error: any) {
    console.error('Error crítico en retiro:', error)
    
    // ROLLBACK SEGURO: Solo devolver el saldo si realmente llegó a restarse en el paso 3
    try {
      if (balanceDeducted && userId && Number.isFinite(amount) && amount > 0) {
        const rbRes = await adjustUserBalance(userId, amount)
        if (rbRes.success) {
          await supabaseAdmin
            .from('transactions')
            .insert({
              user_id: userId,
              type: 'Reembolso',
              amount: amount,
              description: `Reembolso automático por fallo en solicitud de retiro (${method})`
            })
        }
      }
    } catch (rollbackError) {
      console.error('FALLO CRÍTICO EN EL ROLLBACK DE RETIRO:', rollbackError)
    }

    return NextResponse.json({ 
      error: error.message || 'Hubo un problema al procesar tu retiro.' 
    }, { status: 500 })
  }
}

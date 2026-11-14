import { supabaseAdmin } from '@/lib/supabase-admin'

export interface AdjustBalanceResult {
  success: boolean
  newBalance: number
  error?: string
}

/**
 * Ajusta de forma atómica el saldo de un usuario en PostgreSQL/Supabase.
 * Previene condiciones de carrera (Lost Updates) y pérdidas de fondos.
 * Prioriza la llamada RPC `adjust_user_balance` y cuenta con fallback OCC con reintentos.
 */
export async function adjustUserBalance(
  userId: string,
  amount: number,
  allowNegative: boolean = false
): Promise<AdjustBalanceResult> {
  if (!userId || !Number.isFinite(amount) || amount === 0) {
    return { success: false, newBalance: 0, error: 'Parámetros inválidos' }
  }

  const roundedAmount = Math.round(amount * 100) / 100

  // 1. Intentar ejecución atómica vía RPC en Postgres (si no requiere saldo negativo, ya que el RPC estándar bloquea < 0)
  if (!allowNegative) {
    try {
      const { data, error } = await supabaseAdmin.rpc('adjust_user_balance', {
        p_user_id: userId,
        p_amount: roundedAmount
      })

      if (!error && data !== null && data !== undefined) {
        return { success: true, newBalance: Number(data) }
      }

      // Si el RPC falla específicamente por saldo insuficiente y no se permite saldo negativo, rechazar de inmediato
      if (error && (error.message?.includes('Saldo insuficiente') || error.message?.includes('insufficient'))) {
        return { success: false, newBalance: 0, error: error.message }
      }
    } catch (rpcErr) {
      // Si la función RPC aún no está creada en Supabase, pasar al fallback OCC
    }
  }

  // 2. Fallback: Bucle de Control de Concurrencia Optimista (OCC) con reintentos
  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', userId)
      .single()

    if (fetchErr || !profile) {
      return { success: false, newBalance: 0, error: fetchErr?.message || 'Perfil no encontrado' }
    }

    const currentBal = Number(profile.balance || 0)
    const targetBalance = Math.round((currentBal + roundedAmount) * 100) / 100

    if (!allowNegative && targetBalance < 0) {
      return { success: false, newBalance: currentBal, error: 'Saldo insuficiente' }
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ balance: targetBalance })
      .eq('id', userId)
      .eq('balance', profile.balance)
      .select('balance')
      .maybeSingle()

    if (!updateErr && updated) {
      return { success: true, newBalance: Number(updated.balance) }
    }

    // Pequeño backoff aleatorio si hubo colisión concurrente
    await new Promise(r => setTimeout(r, 50 + Math.random() * 50))
  }

  return { 
    success: false, 
    newBalance: 0, 
    error: 'Colisión de concurrencia al actualizar saldo tras reintentos.' 
  }
}

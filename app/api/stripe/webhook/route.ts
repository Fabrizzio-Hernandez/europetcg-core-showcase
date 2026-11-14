import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { adjustUserBalance } from '@/lib/balance';
import { creditStripeDepositSession } from '@/lib/stripeDeposit';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16' as any,
});

// Inicializamos cliente admin de Supabase para bypassear RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Tasa administrativa oficial de Stripe en Europa por gestión de contracargo bancario
const STRIPE_DISPUTE_ADMIN_FEE_EUR = 15.00;

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get('stripe-signature');

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Missing stripe signature or secret' }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err: any) {
    console.error(`Webhook Error: ${err.message}`);
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  // Recargas de monedero: tarjeta (inmediato) y transferencia SEPA (diferido)
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const rawSession = event.data.object as Stripe.Checkout.Session;

    if (rawSession.payment_status === 'paid') {
      const result = await creditStripeDepositSession(rawSession.id);
      if (result.status === 'credited') {
        console.log(`Webhook (${event.type}) acreditó ${result.amountAdded} € (sesión ${rawSession.id})`);
      } else if (result.status === 'invalid') {
        return NextResponse.json({ error: result.error }, { status: result.httpStatus });
      } else if (result.status === 'error') {
        console.error(`Webhook: falló la acreditación de ${rawSession.id}: ${result.error}`);
        return NextResponse.json({ error: 'Failed to update balance' }, { status: 500 });
      }
    } else {
      console.log(`Webhook: sesión ${rawSession.id} en espera de transferencia SEPA (${rawSession.metadata?.netAmount} € netos).`);
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    const rawSession = event.data.object as Stripe.Checkout.Session;
    console.warn(`Webhook: transferencia SEPA fallida o caducada para la sesión ${rawSession.id} (usuario ${rawSession.metadata?.userId}).`);
  } else if (event.type === 'customer_cash_balance_transaction.created') {
    // Transferencias que no cuadran (importe distinto, sin referencia, sobrante): avisar al admin
    try {
      await handleCashBalanceTransaction(event.data.object as Stripe.CustomerCashBalanceTransaction);
    } catch (err: any) {
      console.error('Error procesando customer_cash_balance_transaction.created:', err);
    }
  } else if (event.type === 'account.updated') {
    const account = event.data.object as Stripe.Account;
    const accountId = account.id;

    const { data: currentProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, verification_status, is_authorized_seller')
      .eq('stripe_account_id', accountId)
      .maybeSingle();

    if (currentProfile) {
      // Si el perfil fue rechazado administrativamente, nunca sobreescribir con verificado
      if (currentProfile.verification_status === 'rejected') {
        console.warn(`Account ${accountId} has KYC rejected status, ignoring Stripe authorization.`);
        return NextResponse.json({ received: true });
      }

      if (account.details_submitted && account.charges_enabled && account.payouts_enabled) {
        console.log(`Account ${accountId} is now fully verified by Stripe.`);
        await supabaseAdmin
          .from('profiles')
          .update({ is_authorized_seller: true, verification_status: 'verified' })
          .eq('id', currentProfile.id);
      } else {
        console.log(`Account ${accountId} requires more info. charges_enabled: ${account.charges_enabled}`);
        // No desautorizar a un vendedor que ya haya sido validado previamente
        if (!['verified', 'approved'].includes(currentProfile.verification_status)) {
          await supabaseAdmin
            .from('profiles')
            .update({ is_authorized_seller: false, verification_status: 'pending_stripe' })
            .eq('id', currentProfile.id);
        }
      }
    }
  } else if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeId = dispute.charge as string;
    const disputeAmount = (dispute.amount || 0) / 100;
    const totalRetention = Math.round((disputeAmount + STRIPE_DISPUTE_ADMIN_FEE_EUR) * 100) / 100;
    const reason = dispute.reason || 'unspecified';

    console.warn(`[STRIPE CHARGEBACK ALERT] Dispute initiated for charge ${chargeId}, amount: ${disputeAmount} € (+${STRIPE_DISPUTE_ADMIN_FEE_EUR} € dispute fee), reason: ${reason}`);

    try {
      const charge = await stripe.charges.retrieve(chargeId, {
        expand: ['payment_intent']
      });
      const paymentIntent = charge.payment_intent as Stripe.PaymentIntent | null;
      let userId = paymentIntent?.metadata?.userId || charge.metadata?.userId;

      if (!userId) {
        const searchPattern = paymentIntent?.id || chargeId;
        const { data: matchedTx } = await supabaseAdmin
          .from('transactions')
          .select('user_id')
          .ilike('description', `%${searchPattern}%`)
          .limit(1)
          .maybeSingle();
        if (matchedTx) userId = matchedTx.user_id;
      }

      if (userId) {
        const stripeDisputeMarker = `Disputa #${dispute.id}`;
        const { data: existingDisputeTx } = await supabaseAdmin
          .from('transactions')
          .select('id')
          .eq('user_id', userId)
          .eq('type', 'Disputa_Bancaria')
          .ilike('description', `%${stripeDisputeMarker}%`)
          .maybeSingle();

        if (existingDisputeTx) {
          return NextResponse.json({ received: true, alreadyProcessed: true });
        }

        const { data: userProfile } = await supabaseAdmin
          .from('profiles')
          .select('balance, email, username')
          .eq('id', userId)
          .single();

        if (userProfile) {
          const retentionRes = await adjustUserBalance(userId, -totalRetention, true);
          if (!retentionRes.success) {
            console.error('CRITICAL: Failed to apply Stripe chargeback retention:', retentionRes.error);
            return NextResponse.json({ error: retentionRes.error || 'Error reteniendo saldo por disputa' }, { status: 500 });
          }

          await supabaseAdmin.from('transactions').insert({
            user_id: userId,
            type: 'Disputa_Bancaria',
            amount: -totalRetention,
            description: `Retención preventiva por contracargo bancario Stripe (${disputeAmount.toFixed(2)} € + ${STRIPE_DISPUTE_ADMIN_FEE_EUR.toFixed(2)} € tasa administrativa de disputa — Motivo: ${reason}) - Cargo #${chargeId.slice(-8)} (${stripeDisputeMarker})`
          });

          await supabaseAdmin.from('tickets').insert({
            user_id: userId,
            subject: `ALERTA: Contracargo Bancario Recibido (${disputeAmount} € + ${STRIPE_DISPUTE_ADMIN_FEE_EUR} € tasa)`,
            category: 'Fraude / Contracargo',
            status: 'Abierto',
            message: `Stripe ha reportado un contracargo bancario para el cargo ${chargeId} por ${disputeAmount} € más ${STRIPE_DISPUTE_ADMIN_FEE_EUR} € de tasa administrativa de disputa (Total retenido: ${totalRetention} €, Motivo: ${reason}). El saldo del usuario ha sido congelado preventivamente.`
          });
        }
      }
    } catch (err: any) {
      console.error('Error procesando charge.dispute.created:', err);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  } else if (event.type === 'charge.dispute.closed') {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeId = dispute.charge as string;
    const disputeAmount = (dispute.amount || 0) / 100;
    const totalRestitution = Math.round((disputeAmount + STRIPE_DISPUTE_ADMIN_FEE_EUR) * 100) / 100;
    const disputeStatus = dispute.status;

    console.log(`[STRIPE CHARGEBACK CLOSED] Dispute ${dispute.id} closed with status: ${disputeStatus}`);

    if (disputeStatus === 'won') {
      try {
        const charge = await stripe.charges.retrieve(chargeId, { expand: ['payment_intent'] });
        const paymentIntent = charge.payment_intent as Stripe.PaymentIntent | null;
        const userId = paymentIntent?.metadata?.userId || charge.metadata?.userId;

        if (userId) {
          const wonMarker = `Disputa bancaria Stripe ganada #${dispute.id}`;
          const { data: existingWonTx } = await supabaseAdmin
            .from('transactions')
            .select('id')
            .eq('user_id', userId)
            .eq('type', 'Ingreso')
            .ilike('description', `%${wonMarker}%`)
            .maybeSingle();

          if (existingWonTx) {
            return NextResponse.json({ received: true, alreadyProcessed: true });
          }

          const { data: userProfile } = await supabaseAdmin
            .from('profiles')
            .select('balance')
            .eq('id', userId)
            .single();

          if (userProfile) {
            const restRes = await adjustUserBalance(userId, totalRestitution);
            if (!restRes.success) {
              console.error('CRITICAL: Failed to restore Stripe won dispute balance:', restRes.error);
              return NextResponse.json({ error: restRes.error || 'Error restituyendo saldo' }, { status: 500 });
            }

            await supabaseAdmin.from('transactions').insert({
              user_id: userId,
              type: 'Ingreso',
              amount: totalRestitution,
              description: `Restitución de fondos y tasa administrativa: ${wonMarker} (Cargo #${chargeId.slice(-8)})`
            });
          }
        }
      } catch (err: any) {
        console.error('Error procesando charge.dispute.closed:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ received: true });
}

/**
 * Detecta fondos recibidos por transferencia SEPA que Stripe no pudo aplicar a una recarga
 * (importe distinto al solicitado, sin referencia, sobrantes o recargas caducadas) y abre un ticket para el admin.
 * Esos fondos quedan custodiados en el "saldo de cliente" de Stripe hasta que se apliquen o reembolsen desde el panel.
 */
async function handleCashBalanceTransaction(txn: Stripe.CustomerCashBalanceTransaction) {
  const customerId = typeof txn.customer === 'string' ? txn.customer : txn.customer.id;
  const currency = (txn.currency || 'eur').toLowerCase();

  let reason: string | null = null;

  if (txn.type === 'unapplied_from_payment') {
    reason = 'Una recarga por transferencia caducó o se canceló y los fondos volvieron al saldo del cliente.';
  } else if (txn.type === 'funding_reversed' || txn.type === 'return_initiated') {
    reason = 'El banco emisor revirtió o devolvió una transferencia SEPA entrante.';
  } else if (txn.type === 'applied_to_payment') {
    if (txn.ending_balance > 0) {
      reason = 'El cliente transfirió más de lo solicitado; queda un sobrante sin aplicar en su saldo de Stripe.';
    } else if (txn.applied_to_payment?.payment_intent) {
      const piId = typeof txn.applied_to_payment.payment_intent === 'string'
        ? txn.applied_to_payment.payment_intent
        : txn.applied_to_payment.payment_intent.id;
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status === 'requires_action' && pi.next_action?.type === 'display_bank_transfer_instructions') {
        const remaining = (pi.next_action.display_bank_transfer_instructions?.amount_remaining ?? 0) / 100;
        if (remaining > 0) {
          reason = `El cliente transfirió un importe inferior al total requerido; faltan ${remaining.toFixed(2)} € para completar y acreditar la recarga.`;
        }
      }
    }
  } else if (txn.type === 'funded') {
    const cashBalance = await stripe.customers.retrieveCashBalance(customerId);
    const available = cashBalance.available?.[currency] || 0;
    if (available > 0) {
      const openPis = await stripe.paymentIntents.list({ customer: customerId, limit: 20 });
      const hasOpenTransfer = openPis.data.some(
        pi => pi.status === 'requires_action' && pi.next_action?.type === 'display_bank_transfer_instructions'
      );
      if (!hasOpenTransfer) {
        reason = 'Se recibió una transferencia que no corresponde a ninguna recarga pendiente.';
      }
    }
  }

  if (!reason) return;

  const customer = await stripe.customers.retrieve(customerId);
  const userId = !('deleted' in customer && customer.deleted) ? (customer as Stripe.Customer).metadata?.userId : undefined;
  const amountEur = (Math.abs(txn.net_amount) / 100).toFixed(2);
  const pendingEur = (txn.ending_balance / 100).toFixed(2);
  const marker = `#${txn.id}`;

  const { data: existing } = await supabaseAdmin
    .from('tickets')
    .select('id')
    .ilike('subject', `%${marker}%`)
    .maybeSingle();
  if (existing) return;

  console.warn(`[SEPA] ${reason} Cliente ${customerId}, usuario ${userId || 'desconocido'}, importe ${amountEur} €, saldo sin aplicar ${pendingEur} €.`);

  if (userId) {
    await supabaseAdmin.from('tickets').insert({
      user_id: userId,
      subject: `REVISAR: Transferencia SEPA sin aplicar (${pendingEur} €) ${marker}`,
      category: 'Pagos / Transferencia',
      status: 'Abierto',
      message: `${reason} Importe del movimiento: ${amountEur} €. Saldo pendiente en Stripe: ${pendingEur} €. Cliente Stripe: ${customerId}. Revisa en https://dashboard.stripe.com/customers/${customerId} y aplica o reembolsa los fondos.`,
    });
  }
}

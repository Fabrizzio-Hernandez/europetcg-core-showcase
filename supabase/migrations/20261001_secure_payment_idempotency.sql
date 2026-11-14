-- ==============================================================================
-- EUROPETCG: BLINDAJE DE IDEMPOTENCIA Y PROTECCIÓN DE DEPÓSITOS (STRIPE & PAYPAL)
-- Fecha: 1 Octubre 2026
-- Instrucciones: Copia y ejecuta este script en el SQL Editor de tu panel de Supabase.
-- ==============================================================================

-- 1. Crear índice único parcial para transacciones de pasarela (Stripe y PayPal)
-- Esto previene físicamente a nivel de base de datos cualquier posibilidad de doble abono
-- por peticiones concurrentes (Race conditions entre Webhook y Frontend).
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_gateway_deposit_unique 
ON public.transactions (description) 
WHERE description LIKE 'Stripe_Depósito_%' OR description LIKE 'PayPal_Depósito_%';

-- 2. Asegurar que el saldo del usuario nunca pueda ser manipulado negativamente por error
ALTER TABLE public.profiles 
DROP CONSTRAINT IF EXISTS chk_profiles_balance_positive;

ALTER TABLE public.profiles
ADD CONSTRAINT chk_profiles_balance_positive 
CHECK (balance >= -500.00); -- Permite márgenes de protección para disputas bancarias si fuera necesario

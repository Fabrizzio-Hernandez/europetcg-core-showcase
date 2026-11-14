-- ==============================================================================
-- EUROPETCG - FUNCIÓN RPC ATÓMICA DE AJUSTE DE SALDO (ANTI-RACE CONDITIONS)
-- Fecha: 2026-10-20
-- Instrucciones: Ejecuta este script en el SQL Editor de Supabase (es 100% idempotente).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.adjust_user_balance(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS NUMERIC AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  -- Bloqueo atómico a nivel de fila y cálculo en el motor de Postgres
  UPDATE public.profiles
  SET balance = ROUND((COALESCE(balance, 0) + p_amount)::numeric, 2)
  WHERE id = p_user_id
  RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found: %', p_user_id;
  END IF;

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Otorgar permisos de ejecución exclusivamente para service_role y postgres
REVOKE EXECUTE ON FUNCTION public.adjust_user_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adjust_user_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.adjust_user_balance(UUID, NUMERIC) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_user_balance(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.adjust_user_balance(UUID, NUMERIC) TO postgres;

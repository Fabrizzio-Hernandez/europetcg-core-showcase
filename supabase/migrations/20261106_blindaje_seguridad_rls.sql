-- ==============================================================================
-- BLINDAJE DE SEGURIDAD RLS Y CONTROL DE PRIVILEGIOS EN public.profiles (CORREGIDO)
-- Bloquea ediciones desde el navegador ('authenticated'/'anon') permitiendo
-- al backend ('service_role') y al Table/SQL Editor de Supabase operar sin bloqueos.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_protect_profiles_sensitive_columns()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  -- 1. Obtener el rol de forma compatible con todas las versiones de PostgREST / Supabase
  BEGIN
    v_role := COALESCE(
      auth.role(),
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    );
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  -- 2. Bloquear SOLO si la petición viene desde un cliente web ('authenticated' o 'anon').
  -- Así 'service_role' (tu backend) y 'postgres' / 'supabase_admin' (tu panel de Supabase) tienen permiso total.
  IF v_role IN ('authenticated', 'anon') THEN

    -- A) PROTECCIÓN EN OPERACIONES DE ACTUALIZACIÓN (UPDATE)
    IF TG_OP = 'UPDATE' THEN

      -- 1. Saldo de la billetera (balance)
      IF NEW.balance IS DISTINCT FROM OLD.balance THEN
        RAISE EXCEPTION 'Acceso denegado (403): El saldo de la billetera solo puede ser actualizado por el backend fiduciario de EuropeTCG.';
      END IF;

      -- 2. Tipo de cuenta y categoría de vendedor (account_type, user_type)
      IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
        RAISE EXCEPTION 'Acceso denegado (403): El tipo de cuenta (pro/private) requiere verificación administrativa.';
      END IF;

      IF NEW.user_type IS DISTINCT FROM OLD.user_type THEN
        RAISE EXCEPTION 'Acceso denegado (403): La categoría de usuario (professional/private) requiere solicitud y aprobación KYC.';
      END IF;

      -- 3. Privilegios de Administrador (is_admin)
      IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
        RAISE EXCEPTION 'Acceso denegado (403): Modificación no autorizada de privilegios de administración.';
      END IF;

      -- 4. Vendedor Autorizado (is_authorized_seller)
      IF NEW.is_authorized_seller IS DISTINCT FROM OLD.is_authorized_seller THEN
        RAISE EXCEPTION 'Acceso denegado (403): La autorización de vendedor solo puede ser otorgada por el sistema.';
      END IF;

      -- 5. Estado de verificación de identidad KYC (verification_status)
      IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
        IF NOT (OLD.verification_status IN ('unverified', 'rejected', 'pending') AND NEW.verification_status IN ('pending', 'pending_review')) THEN
          RAISE EXCEPTION 'Acceso denegado (403): No puedes auto-aprobar tu verificación de identidad.';
        END IF;
      END IF;

      -- 6. Reputación y contadores de ventas
      IF NEW.sales_completed IS DISTINCT FROM OLD.sales_completed OR
         NEW.sales_count IS DISTINCT FROM OLD.sales_count OR
         NEW.rating IS DISTINCT FROM OLD.rating OR
         NEW.positive_evals IS DISTINCT FROM OLD.positive_evals OR
         NEW.purchases_completed IS DISTINCT FROM OLD.purchases_completed THEN
        RAISE EXCEPTION 'Acceso denegado (403): Las métricas de ventas, compras y valoraciones son calculadas exclusivamente por el motor de transacciones.';
      END IF;

    END IF;

    -- B) PROTECCIÓN EN OPERACIONES DE INSERCIÓN (INSERT)
    IF TG_OP = 'INSERT' THEN
      NEW.balance := 0.00;
      NEW.is_admin := FALSE;
      NEW.is_authorized_seller := FALSE;
      NEW.sales_completed := 0;
      NEW.sales_count := 0;
      NEW.purchases_completed := 0;
      NEW.positive_evals := 0;
      NEW.rating := 5.00;
      IF NEW.user_type = 'professional' THEN
        NEW.verification_status := 'pending_review';
        NEW.account_type := 'private';
      ELSE
        NEW.user_type := 'private';
        NEW.account_type := 'private';
        NEW.verification_status := COALESCE(NEW.verification_status, 'unverified');
      END IF;
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profiles_sensitive ON public.profiles;

CREATE TRIGGER trg_protect_profiles_sensitive
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_profiles_sensitive_columns();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_self_update_safe" ON public.profiles;

CREATE POLICY "profiles_self_update_safe"
ON public.profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

COMMENT ON FUNCTION public.fn_protect_profiles_sensitive_columns() IS 
'Bloquea ediciones no autorizadas desde el navegador (authenticated/anon) permitiendo al backend (service_role) y a la consola de Supabase operar con normalidad.';

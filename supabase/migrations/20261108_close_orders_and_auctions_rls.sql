-- ==============================================================================
-- EUROPETCG - CIERRE FINAL DE RLS EN ORDERS Y CONFIDENCIALIDAD DE SUBASTAS
-- Fecha: 2026-11-08
-- ==============================================================================
-- Qué hace este script:
-- 1. Elimina las políticas residuales de INSERT y UPDATE directo en public.orders
--    desde clientes web (100% de la creación y mutación de pedidos ocurre vía
--    /api/checkout/process y /api/orders/* con service_role). Esto impide también
--    insertar pedidos basura en estado 'pendiente' desde la consola del navegador.
-- 2. Elimina las políticas residuales de INSERT/UPDATE/DELETE directo en public.auctions
--    desde clientes web (toda creación y gestión pasa por /api/auctions y /api/auctions/bid).
-- 3. Revoca el permiso SELECT de las columnas confidenciales (reserve_price y extra_images)
--    de public.auctions para roles anon y authenticated, impidiendo que un postor lea
--    desde DevTools o WebSockets el precio de reserva secreto del vendedor o el tope
--    máximo (proxy_leader.max_bid) de otro pujador.
-- ==============================================================================

-- 1. Blindaje total de escritura directa en pedidos (solo lectura de pedidos propios)
DROP POLICY IF EXISTS "Users can insert orders" ON public.orders;
DROP POLICY IF EXISTS "Users can update own orders" ON public.orders;

-- 2. Blindaje total de escritura directa en subastas (solo endpoints del servidor)
DROP POLICY IF EXISTS "Sellers can insert auctions" ON public.auctions;
DROP POLICY IF EXISTS "Sellers can update own auctions" ON public.auctions;
DROP POLICY IF EXISTS "Sellers can delete own auctions" ON public.auctions;

-- 3. Protección a nivel de columna para reserve_price y extra_images (proxy_leader.max_bid)
REVOKE SELECT (reserve_price, extra_images) ON public.auctions FROM anon, authenticated;
GRANT SELECT (reserve_price, extra_images) ON public.auctions TO service_role, postgres;

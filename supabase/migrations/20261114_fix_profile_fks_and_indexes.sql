-- ==============================================================================
-- EUROPETCG - RESTORE PROFILE FOREIGN KEYS FOR POSTGREST JOINS & FK INDEXES
-- Fecha: 2026-11-14
-- ==============================================================================
-- Qué hace esta migración:
-- 1. Añade las Foreign Keys faltantes hacia public.profiles(id) en auctions,
--    auction_bids y listing_offers para que los joins de PostgREST en
--    /api/auctions, /api/auctions/[id], /api/user/auctions y /api/offers
--    resuelvan en schema cache sin error 500.
-- 2. Crea los índices de cobertura faltantes para FK en auction_bids,
--    auction_secrets y listing_private_notes (Supabase Performance Advisor).
-- 3. Recarga el esquema de PostgREST inmediatamente.
-- ==============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_auctions_current_bidder'
      AND conrelid = 'public.auctions'::regclass
  ) THEN
    ALTER TABLE public.auctions
      ADD CONSTRAINT fk_auctions_current_bidder
      FOREIGN KEY (current_bidder_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_auctions_winner'
      AND conrelid = 'public.auctions'::regclass
  ) THEN
    ALTER TABLE public.auctions
      ADD CONSTRAINT fk_auctions_winner
      FOREIGN KEY (winner_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_auction_bids_bidder'
      AND conrelid = 'public.auction_bids'::regclass
  ) THEN
    ALTER TABLE public.auction_bids
      ADD CONSTRAINT fk_auction_bids_bidder
      FOREIGN KEY (bidder_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_listing_offers_seller'
      AND conrelid = 'public.listing_offers'::regclass
  ) THEN
    ALTER TABLE public.listing_offers
      ADD CONSTRAINT fk_listing_offers_seller
      FOREIGN KEY (seller_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_auction_bids_bidder_id
  ON public.auction_bids (bidder_id);

CREATE INDEX IF NOT EXISTS idx_auction_secrets_seller_id
  ON public.auction_secrets (seller_id);

CREATE INDEX IF NOT EXISTS idx_listing_private_notes_seller_id
  ON public.listing_private_notes (seller_id);

NOTIFY pgrst, 'reload schema';

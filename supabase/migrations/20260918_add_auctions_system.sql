-- =========================================================================
-- MIGRACIÓN SUPABASE: SISTEMA DE SUBASTAS EN VIVO (LIVE AUCTIONS & BIDDING)
-- Ejecuta este script en el SQL Editor de tu panel de Supabase
-- =========================================================================

-- 1. Tabla de Subastas (auctions)
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game TEXT NOT NULL DEFAULT 'yugioh',
  title TEXT NOT NULL,
  card_name TEXT NOT NULL,
  set_name TEXT,
  rarity TEXT,
  condition TEXT,
  language TEXT DEFAULT 'Español',
  image_url TEXT,
  extra_images JSONB DEFAULT '[]'::jsonb,
  description TEXT,
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  starting_price NUMERIC(10,2) NOT NULL DEFAULT 1.00,
  reserve_price NUMERIC(10,2),
  current_bid NUMERIC(10,2) NOT NULL DEFAULT 1.00,
  current_bidder_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  min_bid_increment NUMERIC(10,2) NOT NULL DEFAULT 1.00,
  total_bids INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'settled', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  anti_sniping_seconds INTEGER NOT NULL DEFAULT 120,
  winner_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  winner_price NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabla de Historial de Pujas (auction_bids)
CREATE TABLE IF NOT EXISTS auction_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Índices para alto rendimiento y consultas en tiempo real
CREATE INDEX IF NOT EXISTS idx_auctions_status_ends ON auctions (status, ends_at);
CREATE INDEX IF NOT EXISTS idx_auctions_game_status ON auctions (game, status);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions (seller_id);
CREATE INDEX IF NOT EXISTS idx_auctions_current_bidder ON auctions (current_bidder_id);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction ON auction_bids (auction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_bids_bidder ON auction_bids (bidder_id);

-- 4. Habilitar RLS
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY;

-- 5. Políticas RLS
DROP POLICY IF EXISTS "Anyone can view active or ended auctions" ON auctions;
CREATE POLICY "Anyone can view active or ended auctions" ON auctions
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authorized users can create auctions" ON auctions;
CREATE POLICY "Authorized users can create auctions" ON auctions
  FOR INSERT WITH CHECK (auth.uid() = seller_id);

DROP POLICY IF EXISTS "Sellers can update their own auctions" ON auctions;
CREATE POLICY "Sellers can update their own auctions" ON auctions
  FOR UPDATE USING (auth.uid() = seller_id);

DROP POLICY IF EXISTS "Anyone can view bids" ON auction_bids;
CREATE POLICY "Anyone can view bids" ON auction_bids
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can place bids" ON auction_bids;
CREATE POLICY "Authenticated users can place bids" ON auction_bids
  FOR INSERT WITH CHECK (auth.uid() = bidder_id);

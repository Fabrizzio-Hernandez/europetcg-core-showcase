# EuropeTCG Core Backend & Security

Módulos de backend, pagos y seguridad en PostgreSQL extraídos del repositorio privado de producción de [EuropeTCG](https://europetcg.eu), un marketplace europeo de cartas coleccionables desarrollado con Next.js App Router, TypeScript y Supabase.

La interfaz pública completa, el catálogo de cartas y los scripts de sincronización privada permanecen en el repositorio privado de la plataforma. Aquí se incluyen las rutas críticas de API, utilidades de dominio, migraciones SQL y su suite de tests unitarios.

## Qué incluye este repositorio

- **Subastas en tiempo real (`app/api/auctions/`, `lib/auction-helpers.ts`, `lib/auctionSettlement.ts`):**
  - Pujas máximas automáticas (proxy bidding) guardando los importes confidenciales y precios de reserva en la tabla aislada `auction_secrets` fuera de la fila pública de `auctions`.
  - Control de concurrencia optimista (CAS) comparando `current_bid` y `total_bids` antes de confirmar la actualización; si entra otra puja simultánea responde `409 Conflict` en lugar de pisar el estado.
  - Ampliación automática Anti-Sniping (`anti_sniping_seconds`) cuando llegan pujas dentro de los últimos 120 segundos y cierre idempotente al finalizar.
- **Pagos, idempotencia y retiradas (`app/api/stripe/webhook/route.ts`, `app/api/withdraw/route.ts`, `lib/balance.ts`, `lib/stripeDeposit.ts`):**
  - Webhooks firmados de Stripe (`constructEvent`), acreditación de depósitos por tarjeta e IBAN virtual SEPA (`customer_balance`) protegida por índice único parcial en base de datos (`idx_transactions_gateway_deposit_unique`).
  - Ajuste atómico de saldos mediante función RPC en PostgreSQL con bloqueo de fila (`UPDATE ... RETURNING`) restringida a `service_role`.
  - Validación de retiradas SEPA separando depósitos sin consumir frente a ganancias reales de ventas y comprobación de umbrales DAC7.
- **Economía, comisiones y seguridad (`lib/commission.ts`, `lib/bundleDiscounts.ts`, `lib/security.ts`, `supabase/migrations/`):**
  - Motor de comisiones por tramos con límite de `50 €` por artículo y descuentos multi-artículo en carrito.
  - Políticas PostgreSQL Row Level Security (RLS), restricción a nivel de columna sobre notas privadas/reservas, saneamiento de redirecciones, allowlist anti-SSRF para imágenes y escape CSV/HTML.

## Estructura

```text
app/api/
  auctions/
    route.ts              Listado público filtrado y creación con verificación KYC
    bid/route.ts          Pujas manuales/proxy, CAS (409) y anti-sniping
  stripe/webhook/         Verificación criptográfica Stripe y disputas
  withdraw/               Validación AML/DAC7 y retiradas SEPA
lib/                      Lógica de subastas, comisiones, saldos, mailer y seguridad
supabase/migrations/      Esquema, índices únicos de idempotencia y políticas RLS
tests/                    Tests unitarios deterministas con Vitest
```

## Verificación en local

Los tests unitarios validan la lógica de dominio, seguridad y helpers sin requerir claves externas ni conexión a base de datos (ver `.env.example` para las variables de producción):

```bash
npm install
npm run typecheck
npm test
```

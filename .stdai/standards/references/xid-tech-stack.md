---
type: references
name: xid-tech-stack
description: Which language, runtime, framework, storage binding, and library XID uses for each layer, and why workers-rs and other alternatives were rejected
---

# XID Tech Stack Inventory

This is the per-layer technology inventory for the XID identity platform, moved out of the root
overview (`.stdai/standards/root.md`) so the always-loaded rules stay small. Read it when you need
to know which library, binding, or runtime feature backs a given layer, which queue / Durable Object
/ binding name to use, or why an alternative was rejected. The root overview keeps only a one-line
summary plus a pointer here.

## Stack

```
Language     TypeScript (workers-rs rejected: an identity product is protocol correctness plus
             I/O, signing goes through Web Crypto, so Rust buys nothing here)
Monorepo     pnpm workspace + turborepo (sole cross-package orchestrator) + Vite+ (vp: Oxlint /
             Oxfmt / Vitest / library packaging) + standard Vite (app build)
Type gate    Official tsc --noEmit via the turbo `typecheck` task. vp's tsgo type checking
             (typeAware + typeCheck) is disabled in the root vite.config.ts: it crashed natively
             on large packages and missed real type errors.
Runtime      Cloudflare Workers
Backend      Hono (protocol surface + Management API)
Frontend     React 19 SPA (standard Vite + @cloudflare/vite-plugin), client-side routing with
             @tanstack/react-router (code-based); src/lib/router.tsx is a react-router-shaped
             compatibility layer over TanStack Router for migrated pages
Data/UI libs @tanstack/react-query, @tanstack/react-table, motion
Styling      StyleX (@stylexjs/stylex compiled by @stylexjs/unplugin, ahead of react() in the
             plugin chain so its babel transform does not collide with the lingui macro chain)
i18n         Full lingui stack (@lingui/core + @lingui/react + @lingui/cli + macros, ICU, .po
             format, Vite 8 via linguiTransformerBabelPreset)
Validation   valibot at every untrusted boundary
Crypto       Web Crypto (crypto.subtle) for primitives; @noble/hashes for Argon2id, which Web
             Crypto does not provide
ORM/DB       Drizzle ORM + D1 (relational data), binding DB
Strong cons. Durable Objects: SessionDO, ChallengeStore, OAuthFlowDO, ParStore, DeviceFlowStore,
             RateLimitStore, AuditSeqDO, MeteringDO
Cache        KV, binding CACHE (JWKS / discovery / branding config)
Objects      R2, binding STORAGE (avatars / logos / email locale packs / exports / GeoIP MMDB)
Async        Queues: xid-email, xid-whatsapp, xid-sms, xid-audit, xid-webhook, xid-metering,
             all with dead letter queue xid-dlq
Email        Cloudflare Email Service, send_email binding EMAIL
Scheduled    Cron Triggers: hourly (`0 * * * *`) expiry cleanup + DAU aggregation; daily
             (`0 2 * * *`) signing key rotation check, certificate polling, domain verification
             polling, SAML IdP metadata refresh, MAU archiving
Secrets      Workers Secrets (KEK / pepper / provider credentials) + envelope encryption in D1
Abuse        Turnstile; WAF + Rate Limiting at the edge; Analytics Engine (binding ANALYTICS)
SAML XML     xmldsigjs + @xmldom/xmldom (+ xml-core, xpath), compatibility_date 2025-04-08 with
             nodejs_compat
```

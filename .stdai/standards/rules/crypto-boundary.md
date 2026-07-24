---
type: rules
name: crypto-boundary
description: Cryptographic primitives come from Web Crypto and are never hand-written; protocol and business logic are in-house; SAML XML signing uses xmldsigjs; format codecs are in-house or tiny dependency-free libraries
priority: high
applyTo:
  - 'packages/crypto/**/*.ts'
  - 'packages/protocol/**/*.ts'
  - 'packages/webauthn/**/*.ts'
  - 'packages/saml/**/*.ts'
targets: [claude-code, codex]
---

# Build-vs-Buy Boundary: Platform Crypto, In-House Protocol, Library XML Signatures

Principle: **cryptographic primitives come from the platform, protocol and business logic are written in-house, legacy XML signature formats use a mature library.** See `docs/design/00-overview.md` section 4.

Five categories decide where a given piece of work belongs -- primitives, protocol kernel, password hashing, format codecs, XML signatures. The full table with the rationale per category: reference `crypto-build-vs-buy-matrix`. Consult it before adding any cryptography-adjacent dependency.

## Prohibitions

- Never hand-write AES / RSA / ECDSA / SHA / HKDF / random number generation. Use `crypto.subtle` and `crypto.getRandomValues`.
- Never pull in a general-purpose crypto library for core signing or verification. `@noble/hashes` is permitted for Argon2id password hashing only (`apps/server/worker/auth/password.ts`); JWT, JWKS, DPoP, envelope encryption and WebAuthn signature paths MUST stay on Web Crypto.
- Never write your own XML signature or canonicalization code. Never disable the XSD validator to work around schema failures (signature wrapping risk).

## SAML on Cloudflare Workers (P0 risk)

Workers has no native XML-DSig, C14N or XML parsing, so the library has to be pure JS. `xmldsigjs` + `@xmldom/xmldom` was selected and the layer has shipped in `packages/saml`, but it is **not yet validated against a real IdP**. Do not describe SAML as production-ready.

The per-library evaluation (saml-jackson, samlify, node-saml, xmldsigjs), the shipped `packages/saml` wiring steps, and the open pre-production risks: reference `saml-library-evaluation`. Read it before changing the SAML dependency set or judging SAML readiness.

---
type: references
name: saml-library-evaluation
description: Why xmldsigjs was chosen over saml-jackson, samlify, and node-saml for SAML on Workers, how packages/saml wires the Web Crypto engine and DOM dependencies, and which risks are still open before production
---

# SAML library evaluation and shipped wiring

Lookup material extracted from the `crypto-boundary` rule. Read it before changing the SAML
dependency set, touching `packages/saml`, or judging whether SAML is production-ready. See
`docs/design/04-enterprise-sso.md` section 8.

## SAML on Cloudflare Workers (P0 risk)

Workers has no native XML-DSig, C14N or XML parsing, so the library has to be pure JS. Recorded evaluation (see `docs/design/04-enterprise-sso.md` section 8):

- `@boxyhq/saml-jackson` (Ory Polis): unusable. Hard dependency on a persistent DB TCP connection; upstream recommends running it as a standalone service.
- `samlify`: unusable. Depends on `xsd-schema-validator`, which shells out to the native `xmllint` binary. Forcing an empty validator introduces signature wrapping risk.
- `@node-saml/node-saml`: not usable directly. The underlying `xml-crypto` relies on `node:crypto` `createVerify` / `createSign`, so the call path would need auditing for OpenSSL-specific behaviour.
- `xmldsigjs` (PeculiarVentures): **selected**. Built on Web Crypto (`crypto.subtle`), which Workers supports natively.

## Shipped implementation

The spike is done and the layer lives in `packages/saml`. `SPIKE_RESULT = 'PASS'` (`packages/saml/src/index.ts`): a full sign-and-verify round-trip runs against Web Crypto in `packages/saml/src/__tests__/spike.test.ts`.

1. `setSamlEngine` (`packages/saml/src/engine.ts`) calls `Application.setEngine('webcrypto', crypto)` once, so xmldsigjs signs and verifies through the runtime's native `crypto.subtle`.
2. DOM and XPath dependencies are injected via `xml-core`'s `setNodeDependencies({ DOMParser, XMLSerializer, xpath })`, backed by `@xmldom/xmldom` + `xpath`. Both are pure JS and bundleable.
3. `nodejs_compat` is enabled with `compatibility_date` `2025-04-08` (`apps/server/wrangler.jsonc`).
4. Dependency set is `xmldsigjs` + `@xmldom/xmldom` + `xml-core` + `xpath` (`packages/saml/package.json`). xmldsigjs 2.8.7 has no `node-webcrypto-ossl` dependency, so no bundler external is needed for it.

## Open risks before production

- `xml-core` picks its XPath implementation at module load time from `typeof self !== 'undefined'`. Workers defines `self` but has no `document.evaluate`, so the browser branch would fail. Retest on the Workers runtime and shim at the bundle layer if needed.
- C14N namespace handling has not been byte-compared against OpenSSL. Run an assertion signature round-trip against real Okta / Azure AD / Google Workspace IdPs before going live. Not done yet.
- Documented fallback, not the current plan: if Workers-runtime verification fails and cannot be fixed at the bundle layer, move SAML processing into a dedicated Durable Object or a Node sidecar and leave the Worker with routing and session handling only.

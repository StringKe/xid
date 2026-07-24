# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | Deutsch | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

Eine edge-native Identitätsplattform, die als ein einziger Cloudflare Worker läuft. Eine Codebasis
dient zugleich als OIDC/OAuth-Identity-Provider, als mandantenfähige RBAC-Schicht, als Endpunkt für
Enterprise-SSO-Föderation (SAML und SCIM) und als passkey-first gehostete Anmeldeoberfläche.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

## Projektstatus

**Vor 1.0. Noch nicht produktiv einsetzen.** Jede unten genannte Fähigkeit ist ausschließlich durch
lokale Nachweise belegt: Unit-Tests, Integrationstests in der Workers-Runtime sowie Browser- bzw.
Protokoll-Client-Smoke-Tests gegen einen lokalen Build. Nichts wurde Ende-zu-Ende gegen einen echten
externen Identity Provider, eine echte nachgelagerte SaaS-Anwendung, einen echten
Social-OAuth-Provider oder echten SMS-/WhatsApp-Versand verifiziert. Evidenzstufen (L0 bis L4) und
die Unterstützungsgrade je Funktion sind in
[`docs/protocols/README.md`](docs/protocols/README.md) definiert; dieses Dokument ist gegenüber
jeder Zusammenfassung hier maßgeblich. Schnittstellen, Datenbankschema und Paket-APIs können sich
ohne Deprecation-Phase ändern.

## Warum XID

Identitätsanfragen sind latenzkritisch und global verteilt, dennoch beantworten die meisten
Identitätsplattformen sie aus einer einzigen Region. XID verlegt den kompletten Authorization Server
an Cloudflares Edge: Die Token-Signatur läuft über Web Crypto innerhalb des Isolates, der
Session-Widerruf wird von einem Durable Object pro Benutzer serialisiert statt von einer zentralen
Datenbank, und JWKS liegt im KV-Cache, sodass Relying Parties Token ohne Round Trip verifizieren.
Auch Mandantenfähigkeit ist kein Aufsatz -- Issuer, Signaturschlüssel, WebAuthn-RP-ID und Policy
werden allesamt aus einem einzigen `TenantContext` aufgelöst. Derselbe Quellbaum läuft damit als
konfigurationsfreie Single-Tenant-Installation oder als mandantenfähige Instanz, gesteuert per
Konfiguration statt per Build-Flag.

## Funktionen

**Protokollumfang**

- OIDC- und OAuth-2.x-Authorization-Server: Discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, dynamische
  Client-Registrierung (RFC 7591/7592) und CIBA-Backchannel-Authentifizierung.
- Authorization Code mit verpflichtendem PKCE S256, Client Credentials, Device Code,
  Refresh-Rotation mit Family-Replay-Widerruf und Token Exchange nach RFC 8693.
  Sender-constrained Token über DPoP und mTLS; signierte Request Objects (JAR) und signierte
  Authorization Responses (JARM).
- Enterprise SSO in beide Richtungen: eingehende Föderation als SAML-2.0-SP und OIDC-RP,
  ausgehender SAML-2.0-IdP für nachgelagerte SaaS-Anwendungen, dazu LDAP Direct Bind,
  WS-Federation, SWA-Passwort-Vaulting und Header-basiertes SSO.
- SCIM-2.0-Service-Provider (Users, Groups, PATCH, Filter, Sortierung, Bulk, ETag/If-Match) sowie
  ausgehendes Provisioning an nachgelagerte SaaS-Ziele.

**Authentifizierung**

- Passkeys/WebAuthn als primäres Credential: Discoverable Credentials, verpflichtende User
  Verification, Klonerkennung über den Sign Count.
- Passwörter mit Argon2id gehasht, dazu ein serverseitiger Pepper in Workers Secrets; Magic Links;
  Einmalcodes per E-Mail, SMS und WhatsApp; Social OAuth in der Rolle als Relying Party.
- MFA mit TOTP, SMS, Passkey als zweitem Faktor und einmalig nutzbaren Backup-Codes.

**Plattform**

- Organisationen, Mitgliedschaften, Rollen, Berechtigungen, Einladungen und Domain-Verifizierung.
- Management-API unter `/v1/*`, Self-Service-Kontoportal unter `/v1/me/*`, Betreiber-API der
  Instanz unter `/v1/platform/*`.
- Append-only-Audit-Log mit verketteten SHA-256-Hashes, signierte Webhooks mit Dead-Letter-Queue,
  Feature Flags und Nutzungserfassung.
- Hosted UI in 8 Sprachen (en, zh-Hans, ja, ko, fr, de, es, pt-BR) mit vollständig übersetzten
  Katalogen.

## Schnellstart

### Eine Anwendung integrieren

Die `@xid-kit/*`-Pakete sind **nicht auf npm veröffentlicht**; es sind Workspace-Pakete. Sie heute
in einer eigenen Anwendung zu nutzen bedeutet deshalb, den Quellcode zu vendorn oder dieses
Repository in den eigenen Workspace aufzunehmen. Die folgende API ist die aktuelle öffentliche
Oberfläche. Aus `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider publishableKey="pk_test_..." apiUrl="https://auth.example.com">
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </XidProvider>
  )
}
```

Innerhalb des Providers liefert `useUser()` eine Discriminated Union über `isLoaded` und
`isSignedIn`, und `useAuth()` stellt `getToken` und `signOut` bereit; die Hooks für Organisation,
Session und API-Keys folgen derselben Form. Serverseitig arbeitet `verifyToken` aus
`@xid-kit/backend` netzwerkfrei -- es genügt, das ohnehin vorliegende JWKS zu übergeben, und nichts
verlässt das Isolate.

```ts
import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(accessToken, {
  jwtKey: jwks, // a JWK, a JWKS, or an imported CryptoKey
  issuer: 'https://auth.example.com',
  authorizedParties: ['app_123'],
})

if (!result.ok) {
  return new Response('unauthorized', { status: 401 }) // result.error names the failed check
}
const userId = result.value.sub
```

`authenticateRequest(request, options)` kapselt dieselbe Prüfung für einen vollständigen `Request`,
und `verifyWebhook(request, options)` validiert eingehende Webhook-Signaturen.

### Self-Hosting

Erfordert Node >= 22.12 und pnpm 10.33.4. D1, KV, Queues und SQLite-gestützte Durable Objects haben
jeweils ein Workers-Free-Kontingent, doch der Mailversand an beliebige Empfänger über das
`send_email`-Binding setzt Workers Paid voraus. Jede Installation, die tatsächlich
Verifizierungsmails, Magic Links oder Einmalcodes zustellt, braucht daher den kostenpflichtigen
Plan.

```bash
git clone https://github.com/StringKe/xid.git
cd xid && pnpm install

# create the resources this Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
for q in xid-email xid-whatsapp xid-sms xid-audit xid-webhook xid-metering xid-dlq; do
  npx wrangler queues create "$q"
done
```

Anschließend `apps/server/wrangler.jsonc` bearbeiten und `account_id`, die D1-`database_id`, die
`id` des KV-Namespace sowie die `routes`-Einträge durch eigene Werte ersetzen. Die Datei trägt
weiterhin die Werte des Upstream-Projekts, es gibt keine Vorlage zum Kopieren, und **unbearbeitet
lässt sie sich nicht deployen**. Die acht Durable-Object-Bindings, das Analytics-Engine-Dataset,
das `send_email`-Binding und die beiden Cron-Trigger sind bereits deklariert und müssen nicht
geändert werden.

Secrets setzen, migrieren, deployen, initialisieren. Geht `KEK` verloren, sind jeder
Signaturschlüssel und jedes gespeicherte Provider-Credential nicht mehr entschlüsselbar; geht
`PEPPER` verloren, ist jeder Passwort-Hash ungültig. Beides zuerst außerhalb von Cloudflare sichern.

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

npx wrangler d1 migrations apply DB --remote
npx wrangler deploy

curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Der Bootstrap legt die Instanz, die Standardorganisation, den ES256-Signaturschlüssel der Instanz
und den ersten `instance_manager`-Benutzer an; ein zweiter Durchlauf wird verweigert. Die
vollständige Anleitung inklusive lokaler D1-Migration und Seeding steht in
[`docs/deployment.md`](docs/deployment.md).

### Entwicklung

```bash
pnpm --filter @xid-kit/server dev   # Vite dev server: Worker and SPA together
pnpm test                           # Vitest across the workspace
pnpm run check                      # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                      # all packages plus the server
```

`pnpm run check` ist das vollständige Gate inklusive zweier Coverage-Läufe; es ist kein schneller
Lint. Es ruft `native:verify` auf, das ohne gesetztes `XID_NATIVE_SDK_PLATFORM` nur den Vertrag des
CI-Workflows prüft und keine native Toolchain benötigt. GitHub Actions verifiziert, deployt aber
nie; das Produktions-Deployment läuft über Cloudflare Workers Builds im Account des
Repository-Eigentümers. Den Workflow je Bereich beschreibt
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Architektur

Ein Worker enthält alles. Hono bedient die Protokoll- und Management-Endpunkte; die React-19-SPA
wird als Workers Assets ausgeliefert und jeder Nicht-API-Pfad fällt auf sie zurück, sodass Hosted
UI, Kontoportal und beide Consoles als eine Einheit zusammen mit dem Token-Endpunkt deployt werden.
Der State ist nach Konsistenzanforderung aufgeteilt: D1 für relationale Daten, Durable Objects für
alles, was Serialisierung braucht (WebAuthn-Challenges, OAuth-State, PAR, Device Flow,
Session-Widerruf, Rate Limits, Audit-Sequenz, Metering), KV für gecachte Lesezugriffe, R2 für Blobs,
Queues für Arbeit, die vom Login-Pfad fernbleiben muss.

```
apps/server/       The Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA: 12 auth pages, 5 account pages, 6 shared console pages,
                   16 organization console pages, 7 platform console pages
packages/          22 workspace packages: 7 kernel libraries + 15 TypeScript SDKs
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

Die Kernbibliotheken -- `protocol`, `crypto`, `webauthn`, `saml`, `db`, `i18n`, `types` -- sind
Worker-intern. Kryptografische Primitive stammen immer aus Web Crypto, XML-DSig ist an `xmldsigjs`
delegiert; die Protokoll- und Geschäftslogik dazwischen ist hier geschrieben.

## Protokollunterstützung

Jede Zeile verweist auf Dateien und Tests in
[`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Bereich | Unterstützung | Höchste Evidenz | Anmerkungen |
| --- | --- | --- | --- |
| OAuth-2.x-Kern (Code, PKCE S256, Client Credentials, Refresh-Rotation) | implementiert | lokaler Protokoll-Client | Implicit- und Password-Grant werden abgelehnt, mit negativen Tests |
| OIDC-Kern (ID Token, Userinfo, Logout, Session Management, Hybrid) | implementiert | lokaler Protokoll-Client | Front-Channel- und Back-Channel-Logout-Profile enthalten |
| PAR, DPoP, Device Flow | implementiert | lokaler Protokoll-Client | DPoP-Nonce-Challenge ist nicht implementiert |
| JAR, JARM, RAR, mTLS, Token Exchange, DCR, CIBA, OpenID Federation | implementiert | Workers-Runtime-Integration | JWE, entferntes Nachladen des Request Object und `form_post.jwt` werden nicht beansprucht |
| SAML 2.0 SP (eingehend) und IdP (ausgehend) | implementiert | lokaler Fake-IdP und Fake-SaaS-SP | Nicht gegen Okta, Entra ID oder Google Workspace verifiziert |
| SCIM-2.0-Service-Provider und ausgehendes Provisioning | implementiert | lokales Fake-SaaS-SCIM | Nicht gegen ein echtes Directory oder SaaS-Ziel verifiziert |
| WebAuthn / Passkeys | implementiert | Workers-Runtime-Integration | Vierstufige Verifikation ohne Bypass-Pfad |
| LDAP Direct Bind, WS-Federation, SWA, Header-basiertes SSO | implementiert | lokales Harness | Kerberos existiert nur in der Dokumentation |
| Social-OAuth-Relying-Party (Google, GitHub, Microsoft, Apple) | implementiert | lokaler Fake-Provider | Nicht mit echten Provider-Secrets oder Callbacks verifiziert |
| Shared Signals, CAEP, RISC | geplant | Unit-Tests | Endpunkte liefern 501 und legen keine Streams an |
| GNAP, UMA, HEART, OID4VP, OID4VCI | Stub | Workers-Runtime-Integration | Route-Stubs, die 501 oder ein Platzhalterobjekt liefern; keine Protokollimplementierung |

## SDKs

Fünfzehn TypeScript-Pakete unter `packages/`: `core` und `backend` sowie Framework-Bindings für
React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron und
Tauri -- alle workspace-privat und **nicht auf npm veröffentlicht**.

Dreizehn native SDKs unter `sdk/`: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS,
Linux, Android und Flutter. **Keines davon ist auf crates.io, PyPI, Maven Central, RubyGems,
Packagist, NuGet, CocoaPods oder pub.dev veröffentlicht**, und eine Release-Pipeline gibt es dafür
nicht -- sie werden aus dem Quellcode eingebunden. Stattdessen erzwingt die CI Korrektheit: sechs
`native-*`-Jobs -- drei davon Matrix-expandiert und damit alle dreizehn Plattformen abdeckend --
führen die jeweils spracheigene Testsuite gemäß dem Vertrag in
`tests/native-sdk-contract.test.mjs` aus. Bei einem Pull Request grenzt ein
`dorny/paths-filter`-Job sie auf die vom Branch berührten SDK-Verzeichnisse ein, zuzüglich `ci.yml`
und der Vertragsdatei selbst; jeder Push auf `main` führt alle dreizehn aus. Lokal lässt sich eine
Plattform mit `XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify` prüfen; die Reifegrade je
Plattform stehen in
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Dokumentation

Einstieg ist [`docs/README.md`](docs/README.md), das nach Lesergruppe weiterleitet. Die meisten
Design- und Betriebsdokumente sind auf Chinesisch; die Protokollmatrizen und mehrere
SDK-Referenzseiten sind auf Englisch.

- Produktdesign, neun Kapitel: [`docs/design/`](docs/design/README.md)
- Protokollmatrizen und Gap-Audit: [`docs/protocols/`](docs/protocols/README.md)
- Verträge der HTTP-Endpunkte: [`docs/api-contracts.md`](docs/api-contracts.md)
- Self-Hosting: [`docs/deployment.md`](docs/deployment.md)
- Quell-URLs der maßgeblichen Standards: [`docs/standards-sources.md`](docs/standards-sources.md)

## Mitwirken, Sicherheit und Lizenz

Vor dem Öffnen eines Pull Requests [`CONTRIBUTING.md`](CONTRIBUTING.md) lesen; dort stehen die
Toolchain, die verpflichtenden Gates und das Sign-off nach dem Developer Certificate of Origin. Für
die Teilnahme gilt [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), und [`SUPPORT.md`](SUPPORT.md)
behandelt Anliegen, die keine Codeänderung sind. Für Schwachstellen bitte kein öffentliches Issue
anlegen -- Meldewege, Scope und Offenlegungszeitplan stehen in [`SECURITY.md`](SECURITY.md).

XID steht unter der MIT-Lizenz; siehe [`LICENSE`](LICENSE). Nutzung, Änderung und Weitergabe sind
erlaubt, auch kommerziell und in Closed-Source-Produkten, solange Copyright-Hinweis und Lizenztext
erhalten bleiben.

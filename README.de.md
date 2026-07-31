# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | Deutsch | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

Eine edge-native Identitätsplattform, die aus einer Codebasis als drei Cloudflare Workers deployt
wird. Der Core Worker stellt OIDC/OAuth, mandantenfähiges RBAC, Enterprise-SSO-Föderation, Hosted
Auth und Kontoseiten bereit. Der Nimbus Site Worker liefert lokalisierte Nimbus-Dokumentation direkt
vom Apex, während ein isolierter Console Worker die Verwaltungsoberfläche bereitstellt.

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

Achtzehn `@xid-kit/*`-TypeScript-Pakete sind als veröffentlichbar konfiguriert und bestehen den
sauberen lokalen Tarball-Consumer-Gate (`pnpm run sdk:distribution:verify`). Im Repository gibt es
keinen Release-Nachweis für ihren aktuellen Zustand in einer externen Registry; der npm-Status ist
daher `UNKNOWN`. Ohne eigene Registry-Prüfung sind der Workspace oder ein lokal erzeugter Tarball
zu verwenden. Die folgende API ist die aktuelle öffentliche Oberfläche. Aus `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
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

# create the resources the Core Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
pnpm --dir ../.. run cloudflare:queues:create
```

Das Queue-Skript leitet alle 24 erforderlichen Ressourcen aus
`apps/server/wrangler.jsonc` ab: 8 Quell-Queues, 8 Quell-spezifische Dead-Letter-Queues und
8 Quarantäne-Queues für Persistenzfehler. Das veraltete gemeinsame `xid-dlq` wird nicht erstellt.

Anschließend die Upstream-Werte für Account und Routes in `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc` und `apps/site/wrangler.jsonc` durch eigene Werte ersetzen. Außerdem
den kanonischen öffentlichen Ursprung in `apps/site/astro.config.ts` auf die eigene HTTPS-Apex-URL
setzen. Die Core-Konfiguration braucht zusätzlich die D1-`database_id` und die `id` des
KV-Namespace. Es gibt keine Self-Hosting-Vorlage, und **mit den Upstream-Werten werden die drei
Workers nicht korrekt deployt**. Die elf Durable-Object-Bindings, das Analytics-Engine-Dataset,
das `send_email`-Binding und die beiden Cron-Trigger gehören nur zu Core und sind bereits deklariert.

Secrets setzen, lokal verifizieren, Workers Builds verbinden und erst nach drei erfolgreichen
Production-Builds initialisieren. Geht `KEK` verloren, sind jeder Signaturschlüssel und jedes
gespeicherte Provider-Credential nicht mehr entschlüsselbar; geht `PEPPER` verloren, ist jeder
Passwort-Hash ungültig. Beides zuerst außerhalb von Cloudflare sichern.

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

cd ../..
pnpm check
pnpm test
pnpm run build
pnpm smoke:three-workers
```

`xid`, `xid-console` und `xid-site` als drei Cloudflare-Workers-Builds-Projekte mit diesem
Git-Repository verbinden. Für alle den Production-Branch auf `main` setzen und
Non-Production-Branch-Builds sowie Worker Preview URLs deaktivieren. Root-, Build- und
Deploy-Befehle stehen in [`docs/deployment.md`](docs/deployment.md). Einen geprüften und signierten
Commit nach `main` mergen; Workers Builds führt die D1-Remote-Migrationen aus und deployt alle drei
Worker. Nach erfolgreichen Builds:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Der Bootstrap legt die Instanz, die Standardorganisation, den ES256-Signaturschlüssel der Instanz
und den ersten `instance_manager`-Benutzer an; ein zweiter Durchlauf wird verweigert. Die
vollständige Anleitung inklusive lokaler D1-Migration, Seeding, Release-Reihenfolge der drei Worker
und Rollback steht in [`docs/deployment.md`](docs/deployment.md). Ein Self-Hosting-Release muss
Core, Console und Site deployen. Site übernimmt Apex, Docs in 8 Locales, SEO, Pagefind, Agent
Surfaces und den `www` 308; Console übernimmt `/console` und `/console/*`.

### Entwicklung

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` ist das vollständige Gate inklusive zweier Coverage-Läufe; es ist kein schneller
Lint. Es ruft `native:verify` auf, das ohne gesetztes `XID_NATIVE_SDK_PLATFORM` nur die
Vertragsmatrix der nativen SDKs prüft und keine native Toolchain benötigt. GitHub Actions
verifiziert, deployt aber nie; das Produktions-Deployment läuft über Cloudflare Workers Builds im
Account des Repository-Eigentümers. Den Workflow je Bereich beschreibt
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Architektur

Drei Worker teilen einen Hostname, aber keine Runtime-Bindings. Nimbus Site übernimmt den
Apex-Dokumentationshub, alle 8 Locale-Dokumentationsbäume, SEO, Pagefind, Markdown- und MDX-Twins, LLM-Indexes
und den 308 von `www` zu Apex. Console ist ein statischer Worker ohne Bindings und übernimmt
`/console` und `/console/*` auf Apex- und Tenant-Hosts. Core übernimmt Hosted Auth, Kontoseiten,
Protokoll- und API-Routes sowie `/_core/*`; nur Core besitzt D1, Durable Objects, KV, R2, Queues,
E-Mail-, Analytics-Engine- und Cron-Bindings.

Der Core-State ist nach Konsistenzanforderung aufgeteilt: D1 für relationale Daten, Durable Objects
für alles, was Serialisierung braucht (WebAuthn-Challenges, OAuth-State, PAR, Device Flow,
Session-Widerruf, Rate Limits, Audit-Sequenz, Metering), KV für gecachte Lesezugriffe, R2 für Blobs,
Queues für Arbeit, die vom Login-Pfad fernbleiben muss.

```
apps/site/         Nimbus docs Site: apex hub, localized docs, SEO, Pagefind, agent surfaces, www 308
apps/console/      Binding-free static management UI for /console and /console/*
apps/server/       Identity Core Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA for Hosted Auth and account pages
packages/          23 workspace packages: 15 TypeScript SDKs + 3 public runtime kernels + 5 private implementation packages
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

Die öffentlichen Runtime-Kernels sind `protocol`, `crypto` und `types`. Die privaten
Implementierungspakete sind `webauthn`, `saml`, `db`, `i18n` und `web-ui`. Kryptografische Primitive
stammen immer aus Web Crypto, XML-DSig ist an `xmldsigjs` delegiert; die Protokoll- und
Geschäftslogik dazwischen ist hier geschrieben.

## Protokollunterstützung

Jede Zeile verweist auf Dateien und Tests in
[`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Bereich                                                                | Unterstützung | Höchste Evidenz                   | Anmerkungen                                                                               |
| ---------------------------------------------------------------------- | ------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| OAuth-2.x-Kern (Code, PKCE S256, Client Credentials, Refresh-Rotation) | implementiert | lokaler Protokoll-Client          | Implicit- und Password-Grant werden abgelehnt, mit negativen Tests                        |
| OIDC-Kern (ID Token, Userinfo, Logout, Session Management, Hybrid)     | implementiert | lokaler Protokoll-Client          | Front-Channel- und Back-Channel-Logout-Profile enthalten                                  |
| PAR, DPoP, Device Flow                                                 | implementiert | lokaler Protokoll-Client          | DPoP-Nonce-Challenge ist nicht implementiert                                              |
| JAR, JARM, RAR, mTLS, Token Exchange, DCR, CIBA, OpenID Federation     | implementiert | Workers-Runtime-Integration       | JWE, entferntes Nachladen des Request Object und `form_post.jwt` werden nicht beansprucht |
| SAML 2.0 SP (eingehend) und IdP (ausgehend)                            | implementiert | lokaler Fake-IdP und Fake-SaaS-SP | Nicht gegen Okta, Entra ID oder Google Workspace verifiziert                              |
| SCIM-2.0-Service-Provider und ausgehendes Provisioning                 | implementiert | lokales Fake-SaaS-SCIM            | Nicht gegen ein echtes Directory oder SaaS-Ziel verifiziert                               |
| WebAuthn / Passkeys                                                    | implementiert | Workers-Runtime-Integration       | Vierstufige Verifikation ohne Bypass-Pfad                                                 |
| LDAP Direct Bind, WS-Federation, SWA, Header-basiertes SSO             | implementiert | lokales Harness                   | Kerberos existiert nur in der Dokumentation                                               |
| Social-OAuth-Relying-Party (Google, GitHub, Microsoft, Apple)          | implementiert | lokaler Fake-Provider             | Nicht mit echten Provider-Secrets oder Callbacks verifiziert                              |
| Shared Signals, CAEP, RISC                                             | geplant       | Unit-Tests                        | Endpunkte liefern 501 und legen keine Streams an                                          |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | Stub          | Workers-Runtime-Integration       | Route-Stubs, die 501 oder ein Platzhalterobjekt liefern; keine Protokollimplementierung   |

## SDKs

Unter `packages/` liegen 15 TypeScript-SDK-Pakete: `core` und `backend` sowie Framework-Bindings
für React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron
und Tauri. Zusammen mit den 3 öffentlichen Runtime-Kernels (`crypto`, `protocol`, `types`) sind
18 Pakete als veröffentlichbar konfiguriert und durch saubere lokale Tarball-Installationen
geprüft. Die übrigen 5 Pakete (`db`, `i18n`, `saml`, `web-ui`, `webauthn`) sind private
Implementierungspakete. Der Veröffentlichungszustand in der externen npm-Registry bleibt
`UNKNOWN`; lokale Distributionsevidenz ist kein Registry-Release-Nachweis.

Dreizehn native SDKs unter `sdk/`: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS,
Linux, Android und Flutter. **Keines davon ist auf crates.io, PyPI, Maven Central, RubyGems,
Packagist, NuGet, CocoaPods oder pub.dev veröffentlicht**, und eine Release-Pipeline gibt es dafür
nicht -- sie werden aus dem Quellcode eingebunden. Die CI installiert keine Sprach-Toolchain und
führt keine ihrer Testsuiten aus. Geprüft wird die Vertragsmatrix in
`tests/native-sdk-contract.test.mjs`: `pnpm check` ruft im `check`-Job `native:verify` auf, und das
stellt sicher, dass jeder Plattformeintrag der Matrix auf ein tatsächlich vorhandenes Verzeichnis
zeigt. Die echte Toolchain einer Plattform auszuführen ist ein lokaler Opt-in-Schritt:
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`. Die Reifegrade je Plattform stehen in
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Dokumentation

Einstieg ist [`docs/README.md`](docs/README.md), das nach Lesergruppe weiterleitet. Alles unter
`docs/` ist auf Englisch geschrieben, und die englische Fassung ist maßgeblich. Ein Spiegel auf
vereinfachtes Chinesisch liegt unter [`docs/zh-Hans/`](docs/zh-Hans/README.md) und deckt nur die
Einstiegsdokumente und die Designkapitel ab. **Eine deutsche Übersetzung der Dokumentation gibt es
nicht.**

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

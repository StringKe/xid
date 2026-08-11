# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | Deutsch | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

Eine edge-native Identitätsplattform, die aus einer Codebasis als drei Cloudflare Workers deployt
wird. Der Core Worker stellt OIDC/OAuth, mandantenfähiges RBAC, Enterprise-SSO-Föderation, Hosted
Auth und Kontoseiten bereit. Der Nimbus Site Worker liefert lokalisierte Nimbus-Dokumentation direkt
vom Apex, während ein isolierter Console Worker die Verwaltungsoberfläche bereitstellt.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## Projektstatus

**Vor 1.0 (Pre-1.0).** Bis 1.0.0 können öffentliche APIs, Datenbankschema und Paket-Oberflächen noch
ohne lange Deprecation-Phase ändern.

Die gehostete Bereitstellung [https://xid.dev](https://xid.dev) läuft produktiv. First-Party-Pfade
von Hosted Auth, Console, Management API und verwandten Kernflächen haben **Production-(L4)**-Nachweise
gegen diese Instanz (siehe [`docs/api-contracts.md`](docs/api-contracts.md) und
`pnpm run smoke:production*`). Die breitere Matrix stützt sich weiterhin auf lokale L0–L3-Unit-,
Workers-Runtime- und Browser- bzw. Protokoll-Client-Tests.

**Nicht** production-supported, solange keine echte L4-Zeile für den Pfad vorliegt: Enterprise-IdPs
(Okta, Microsoft Entra ID u. a.), Downstream-SaaS-SSO/SCIM (Slack, GitHub Enterprise u. a.), Social
OAuth mit echten Secrets und Callbacks sowie SMS-/WhatsApp-Zustellung. Lokale Implementierung oder
`provider-ready` ist keine production-supported-Aussage.

Evidenzstufen (L0 bis L4) und Unterstützungsgrade je Funktion stehen in
[`docs/protocols/README.md`](docs/protocols/README.md) und haben Vorrang vor jeder Zusammenfassung hier.

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

**Protokolle und Föderation**

- Der OIDC- und OAuth-2.x-Authorization-Server bietet Discovery, JWKS, Protected Resource Metadata,
  `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/end_session`, PAR, Device Flow,
  Dynamic Client Registration, CIBA, Hybrid Responses sowie Front-Channel-, Back-Channel- und
  Session-Management-Logout-Pfade.
- Authorization Code erzwingt PKCE S256 und unterstützt Client Credentials, Refresh-Token-Rotation
  mit Family-Widerruf bei Replay sowie Token Exchange nach RFC 8693. Resource Indicators, DPoP,
  mTLS, JAR, JARM, RAR und lokale Enforcement-Profile für Browser-Based Apps und FAPI 2.0 sind
  implementiert.
- Enterprise SSO funktioniert in beide Richtungen: eingehende SAML-2.0-SP- und OIDC-RP-Föderation,
  ausgehender SAML-2.0-IdP und OIDC-Anwendungen für nachgelagerte SaaS-Dienste sowie LDAP Direct
  Bind, WS-Federation, SWA-Passwort-Vaulting, Header-basiertes SSO und ein Directory Connector
  Framework.
- Der SCIM-2.0-Service-Provider unterstützt Users, Groups, PATCH, Filter, Projektion, Sortierung,
  Bulk und ETag/If-Match sowie ausgehendes Users-/Groups-Provisioning an SaaS-Ziele.
- OpenID Federation ist auf eine minimale Entity-Metadata- und Registrierungsgrenze beschränkt.
  Trust-Chain-Auflösung, Trust Anchors, Authority-Hint-Traversierung und produktive
  Interoperabilität sind nicht implementiert.

**Authentifizierung und Kontolebenszyklus**

- Passkeys/WebAuthn sind das primäre Credential, mit Discoverable Credentials, verpflichtender
  User Verification, ES256-/RS256-/EdDSA-Verifikation, Klonerkennung über den Sign Count und
  policy-gesteuerter Validierung von Packed Enterprise Attestation.
- Passwörter verwenden Argon2id und einen serverseitigen Pepper in Workers Secrets. Passwordless
  Sign-in unterstützt Magic Links und Einmalcodes per E-Mail, SMS und WhatsApp; der
  Social-OAuth-Relying-Party-Flow unterstützt Google, GitHub, Microsoft Account und Apple.
- MFA unterstützt TOTP, SMS, Passkey Challenges, einmalige Backup-Codes und an die aktuelle Session
  gebundenes OIDC-AAL2-Step-up. AAL3 wird ausdrücklich nicht beansprucht.
- Guest Sign-in bietet Firebase-artige Lazy Reuse und ein One-Click-In-Place-Passkey-Upgrade bei
  erhaltenem `sub`. Browser-Clients erhalten zusätzlich stille `prompt=none`-Reauthentifizierung
  per verstecktem Iframe mit Top-Level-Redirect als Fallback.
- Hosted Auth und das Kontoportal implementieren Einladungsannahme, E-Mail-Verifizierung,
  Self-Service-Onboarding eines Top-Level-Tenants, Auswahl der aktiven Organization, Session-
  Verwaltung und Self-Service-Credential-Verwaltung.

**Organisationen und Autorisierung**

- Instances, Organizations, einstufige SubOrgs, Memberships, Projects, Applications, Rollen,
  Berechtigungen, Benutzer- und Cross-Organization-Grants, Einladungen und Domain-Verifizierung.
- OrgUnit-Bäume modellieren Abteilungen und Teams innerhalb einer Organization, mit primären und
  sekundären Zuordnungen, maximaler Tiefe 8, Verschieben und Archivieren von Teilbäumen sowie
  Manager-Auflösung entlang der Berichtslinie. OrgUnits werden weder Tenant-Grenzen noch Token
  Claims.
- Jedes Project kann `open`, `restricted` oder `approval_required` sein. Die Autorisierung innerhalb
  derselben Organization erzwingt diese Policy; Benutzer können Zugriff anfordern, Approver werden
  über die OrgUnit-Berichtslinie und Management-Fallbacks aufgelöst, und eine Genehmigung kann einen
  ablaufenden `user_grant` erstellen.

**Betrieb und Zustellung**

- Management-API unter `/v1/*`, Self-Service-Kontoportal unter `/v1/me/*` und separat geschützte
  Instanzbetreiber-API unter `/v1/platform/*`.
- Append-only-Audit-Events nutzen eine SHA-256-Hashkette je Tenant und redigieren sensible Metadaten
  vor der Persistierung. Acht asynchrone Pipelines besitzen unabhängige Dead-Letter- und
  Quarantine-Pfade mit Lease-basiertem Replay; Metering-Fehler fallen auf eine D1-Outbox zurück.
- Signierte Webhooks unterstützen verschlüsselte Secrets, Rotation, Retry, idempotente Message IDs
  und Dead-Letter-Snapshots. Self-Service-Privacy-Flows bieten private R2-Exporte und verzögertes,
  abbrechbares Erasure mit Schutz des einzigen Organization Owners und letzten Instance Managers.
- Feature Flags, Branding, Nutzungsmessung, Ankündigungen, Compliance-Artefakte und die Hosted UI in
  8 Sprachen (en, zh-Hans, ja, ko, fr, de, es, pt-BR) werden aus derselben Codebasis verwaltet.

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

| Bereich                                                                | Unterstützung | Höchste Evidenz                   | Anmerkungen                                                                   |
| ---------------------------------------------------------------------- | ------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| OAuth-2.x-Kern (Code, PKCE S256, Client Credentials, Refresh-Rotation) | implementiert | lokaler Protokoll-Client          | Implicit- und Password-Grant werden abgelehnt, mit negativen Tests            |
| OIDC-Kern (ID Token, Userinfo, Logout, Session Management, Hybrid)     | implementiert | lokaler Protokoll-Client          | Front-Channel- und Back-Channel-Logout-Profile enthalten                      |
| PAR, DPoP, Device Flow                                                 | implementiert | lokaler Protokoll-Client          | DPoP-Nonce-Challenge ist nicht implementiert                                  |
| Browser-Based-Apps- und FAPI-2.0-Enforcement-Profile                   | implementiert | Workers-Runtime-Integration       | Nur lokale Policy-Evidenz, kein produktiver Conformance-Anspruch              |
| JAR, JARM, RAR, mTLS, Token Exchange, DCR, CIBA                        | implementiert | Workers-Runtime-Integration       | JWE, Remote Request Object Fetch und `form_post.jwt` werden nicht beansprucht |
| OpenID Federation                                                      | implementiert | Workers-Runtime-Integration       | Nur minimale Metadata- und Registrierungsgrenze, keine Trust-Chain-Auflösung  |
| SAML 2.0 SP (eingehend) und IdP (ausgehend)                            | implementiert | lokaler Fake-IdP und Fake-SaaS-SP | Nicht gegen Okta, Entra ID oder Google Workspace verifiziert                  |
| SCIM-2.0-Service-Provider und ausgehendes Provisioning                 | implementiert | lokales Fake-SaaS-SCIM            | Nicht gegen ein echtes Directory oder SaaS-Ziel verifiziert                   |
| WebAuthn, Passkeys, Passkey MFA und AAL2-Step-up                       | implementiert | Workers-Runtime-Integration       | Enthält lokal EdDSA und Packed Attestation; AAL3 wird nicht unterstützt       |
| LDAP Direct Bind, WS-Federation, SWA, Header-basiertes SSO             | implementiert | lokales Harness                   | Kerberos existiert nur in der Dokumentation                                   |
| Social-OAuth-Relying-Party (Google, GitHub, Microsoft, Apple)          | implementiert | lokaler Fake-Provider             | Nicht mit echten Provider-Secrets oder Callbacks verifiziert                  |
| Shared Signals, CAEP, RISC                                             | geplant       | negative Route-Tests              | Endpunkte liefern 501 und legen keine Streams an                              |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | geplant       | negative Route-Tests              | Reservierte Routen liefern 501 und sind keine Protokollimplementierungen      |

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

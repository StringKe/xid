# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Français | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

Une plateforme d'identité nativement conçue pour l'edge, déployée depuis une seule base de code sous
forme de trois Cloudflare Workers. Le Core Worker fournit OIDC/OAuth, le RBAC multi-tenant, la
fédération SSO d'entreprise, la Hosted Auth et les pages de compte. Le Nimbus Site Worker fournit
la documentation Nimbus localisée depuis l'apex, tandis qu'un Console Worker isolé fournit l'interface
de gestion.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

## État du projet

**Pré-1.0. Ne déployez pas encore ce projet en production.** Chacune des capacités décrites
ci-dessous ne repose que sur des preuves locales : tests unitaires, tests d'intégration sur le
runtime Workers et tests de fumée menés depuis un navigateur ou un client de protocole contre un
build local. Rien n'a été vérifié de bout en bout face à un véritable fournisseur d'identité
externe, à une véritable application SaaS en aval, à un véritable fournisseur OAuth social ou à une
véritable livraison SMS/WhatsApp. Les niveaux de preuve (L0 à L4) et les niveaux de support par
fonctionnalité sont définis dans [`docs/protocols/README.md`](docs/protocols/README.md), qui fait
autorité sur tout résumé présenté ici. Les interfaces, le schéma de base de données et les API des
packages peuvent changer sans période de dépréciation.

## Pourquoi XID

Les requêtes d'identité sont critiques en latence et réparties dans le monde entier, pourtant la
plupart des plateformes d'identité y répondent depuis une seule région. XID place l'intégralité du
serveur d'autorisation sur l'edge de Cloudflare : la signature des tokens s'exécute via Web Crypto
au sein de l'isolate, la révocation de session est sérialisée par un Durable Object dédié à chaque
utilisateur plutôt que par une base de données centrale, et le JWKS est mis en cache dans KV pour
que les relying parties vérifient les tokens sans aller-retour réseau. Le multi-tenant n'est pas
non plus un ajout après coup : issuer, clés de signature, RP ID WebAuthn et politiques se résolvent
tous depuis un unique `TenantContext`, si bien que le même arbre de sources tourne aussi bien en
déploiement mono-tenant sans configuration qu'en instance multi-tenant, par configuration et non
par un flag de build.

## Fonctionnalités

**Surface protocolaire**

- Serveur d'autorisation OIDC et OAuth 2.x : discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, enregistrement
  dynamique de client (RFC 7591/7592) et authentification backchannel CIBA.
- Authorization code avec PKCE S256 obligatoire, client credentials, device code, rotation des
  refresh tokens avec révocation de la famille en cas de rejeu, et token exchange RFC 8693. Tokens
  sender-constrained via DPoP et mTLS ; objets de requête signés (JAR) et réponses d'autorisation
  signées (JARM).
- SSO d'entreprise dans les deux sens : fédération entrante en SAML 2.0 SP et OIDC RP, IdP SAML 2.0
  sortant pour les SaaS en aval, plus bind direct LDAP, WS-Federation, coffre-fort de mots de passe
  SWA et SSO par en-têtes.
- SCIM 2.0 Service Provider (Users, Groups, PATCH, filtres, tri, bulk, ETag/If-Match) et
  provisioning sortant vers des cibles SaaS en aval.

**Authentification**

- Passkeys/WebAuthn comme credential principal : discoverable credentials, user verification
  obligatoire, détection de clonage par sign-count.
- Mots de passe hachés en Argon2id avec un pepper côté serveur conservé dans Workers Secrets ;
  magic links ; codes à usage unique par e-mail, SMS et WhatsApp ; OAuth social en tant que
  relying party.
- MFA par TOTP, SMS, passkey en second facteur et codes de secours à usage unique.

**Plateforme**

- Organisations, appartenances, rôles, permissions, invitations et vérification de domaine.
- Management API sous `/v1/*`, portail de compte en libre-service sous `/v1/me/*`, API opérateur
  d'instance sous `/v1/platform/*`.
- Journal d'audit append-only à hachages SHA-256 chaînés, webhooks signés avec file de lettres
  mortes, feature flags et comptage d'usage.
- Hosted UI en 8 langues (en, zh-Hans, ja, ko, fr, de, es, pt-BR), catalogues intégralement
  traduits.

## Démarrage rapide

### Intégrer une application

Dix-huit packages TypeScript `@xid-kit/*` sont configurés comme publiables et passent le contrôle
de consommation depuis des tarballs locaux propres (`pnpm run sdk:distribution:verify`). Le dépôt
ne contient aucune preuve de release établissant leur état actuel dans un registre externe ; le
statut de publication npm est donc `UNKNOWN`. Sans vérification indépendante du registre, utilisez
le workspace ou un tarball produit localement. L'API ci-dessous est la surface publique actuelle.
Depuis `@xid-kit/react` :

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

À l'intérieur du provider, `useUser()` renvoie une union discriminée sur `isLoaded` et
`isSignedIn`, et `useAuth()` expose `getToken` et `signOut` ; les hooks d'organisation, de session
et de clé d'API suivent la même forme. Côté serveur, `verifyToken` de `@xid-kit/backend` fonctionne
sans réseau -- passez le JWKS que vous détenez déjà et rien ne quitte l'isolate.

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

`authenticateRequest(request, options)` applique le même contrôle à une `Request` entière, et
`verifyWebhook(request, options)` valide les signatures des webhooks entrants.

### Auto-hébergement

Nécessite Node >= 22.12 et pnpm 10.33.4. D1, KV, Queues et les Durable Objects adossés à SQLite
disposent tous d'un palier gratuit Workers, mais l'envoi de courrier à des destinataires
quelconques via le binding `send_email` exige Workers Paid : tout déploiement qui délivre
réellement des e-mails de vérification, des magic links ou des codes à usage unique a donc besoin
du plan payant.

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

Le script Queue dérive les 24 ressources requises depuis `apps/server/wrangler.jsonc` :
8 Queues sources, 8 dead-letter Queues propres à chaque source et 8 Queues de quarantaine pour les
échecs de persistance. Il ne crée pas l'ancien `xid-dlq` partagé.

Remplacez ensuite les valeurs d'account et de route amont dans `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc` et `apps/site/wrangler.jsonc`. Définissez aussi l'origine publique
canonique dans `apps/site/astro.config.ts` sur votre URL HTTPS apex. La configuration Core a
également besoin de votre `database_id` D1 et de l'`id` de votre namespace KV. Il n'existe aucun
modèle d'auto-hébergement à copier, et **les trois Workers ne se déploieront pas correctement tant
que ces valeurs amont subsistent**. Les onze bindings Durable Object, le dataset Analytics Engine,
le binding `send_email` et les deux cron triggers appartiennent uniquement au Core et sont déjà
déclarés.

Définissez les secrets, vérifiez en local, connectez Workers Builds, puis initialisez après la
réussite des trois builds de production. Perdre `KEK` rend indéchiffrables toutes les clés de
signature et tous les identifiants de provider stockés ; perdre `PEPPER` invalide tous les hachages
de mots de passe. Sauvegardez les deux hors de Cloudflare au préalable.

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

Connectez `xid`, `xid-console` et `xid-site` comme trois projets Cloudflare Workers Builds adossés à
ce dépôt Git. Définissez `main` comme branche de production, désactivez les builds des branches
non-production et les Worker Preview URLs, puis utilisez les commandes root, build et deploy de
[`docs/deployment.md`](docs/deployment.md). Fusionnez dans `main` un commit relu et signé ; Workers
Builds applique les migrations D1 distantes et déploie les trois Workers. Après leur réussite :

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Le bootstrap crée l'instance, l'organisation par défaut, la clé de signature ES256 de l'instance et
le premier utilisateur `instance_manager` ; il refuse de s'exécuter deux fois. Les instructions
complètes, y compris la migration et le seeding D1 en local, l'ordre de release des trois Workers et
le rollback, se trouvent dans [`docs/deployment.md`](docs/deployment.md). Une release auto-hébergée
doit déployer Core, Console et Site. Site gère l'apex, les docs en 8 locales, le SEO, Pagefind, les
agent surfaces et la redirection `www` 308 ; Console gère `/console` et `/console/*`.

### Développer

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` est le contrôle complet, deux passes de couverture comprises ; ce n'est pas un
lint rapide. Il appelle `native:verify` qui, sans `XID_NATIVE_SDK_PLATFORM` défini, se contente de
valider la matrice de contrat des SDK natifs et n'exige aucune toolchain native. GitHub Actions
vérifie mais ne déploie jamais ; le déploiement en production part de Cloudflare Workers Builds sur
le compte du propriétaire du dépôt. Voir [`CONTRIBUTING.md`](CONTRIBUTING.md) pour le workflow
propre à chaque domaine.

## Architecture

Trois Workers partagent le même hostname sans partager leurs runtime bindings. Nimbus Site gère le
hub de documentation apex, les 8 arbres de documentation localisés, le SEO, Pagefind, les twins Markdown et MDX,
les LLM indexes et la redirection 308 de `www` vers apex. Console est un Worker statique sans
binding qui gère `/console` et `/console/*` sur l'apex et les tenant hosts. Core gère la Hosted
Auth, les pages de compte, les routes de protocole et d'API ainsi que `/_core/*` ; il est le seul
Worker doté de D1, Durable Objects, KV, R2, Queues, email, Analytics Engine et cron bindings.

L'état du Core est réparti selon l'exigence de cohérence : D1 pour les données relationnelles,
Durable Objects pour tout ce qui demande une sérialisation (challenges WebAuthn, state OAuth, PAR,
device flow, révocation de session, limitation de débit, séquence d'audit, comptage d'usage), KV
pour les lectures mises en cache, R2 pour les blobs, Queues pour le travail qui doit rester hors du
chemin de connexion.

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

Les kernels runtime publics sont `protocol`, `crypto` et `types`. Les packages d'implémentation
privés sont `webauthn`, `saml`, `db`, `i18n` et `web-ui`. Les primitives cryptographiques
proviennent toujours de Web Crypto et la XML-DSig est déléguée à `xmldsigjs` ; tout le protocole et
la logique métier intermédiaires sont écrits ici.

## Support des protocoles

Chaque ligne renvoie à des fichiers et des tests recensés dans
[`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Domaine                                                                            | Support    | Preuve la plus forte            | Notes                                                                                          |
| ---------------------------------------------------------------------------------- | ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Noyau OAuth 2.x (code, PKCE S256, client credentials, rotation des refresh tokens) | implémenté | client de protocole local       | Les grants implicit et password sont rejetés, avec tests négatifs                              |
| Noyau OIDC (ID token, userinfo, logout, session management, hybrid)                | implémenté | client de protocole local       | Les profils de logout front-channel et back-channel sont inclus                                |
| PAR, DPoP, device flow                                                             | implémenté | client de protocole local       | Le nonce challenge DPoP n'est pas implémenté                                                   |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA, OpenID Federation                 | implémenté | intégration runtime Workers     | JWE, la récupération distante des request objects et `form_post.jwt` ne sont pas revendiqués   |
| SAML 2.0 SP (entrant) et IdP (sortant)                                             | implémenté | faux IdP et faux SP SaaS locaux | Non vérifié face à Okta, Entra ID ou Google Workspace                                          |
| SCIM 2.0 Service Provider et provisioning sortant                                  | implémenté | faux SCIM SaaS local            | Non vérifié face à un annuaire ou une cible SaaS réels                                         |
| WebAuthn / passkeys                                                                | implémenté | intégration runtime Workers     | Vérification en quatre étapes, sans chemin de contournement                                    |
| LDAP direct bind, WS-Federation, SWA, SSO par en-têtes                             | implémenté | harnais local                   | Kerberos n'existe qu'en documentation                                                          |
| OAuth social en relying party (Google, GitHub, Microsoft, Apple)                   | implémenté | faux provider local             | Non vérifié avec de vrais secrets ni de vrais callbacks de provider                            |
| Shared Signals, CAEP, RISC                                                         | planifié   | tests unitaires                 | Les endpoints renvoient 501 et ne créent aucun stream                                          |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                                  | stub       | intégration runtime Workers     | Stubs de route renvoyant 501 ou un objet de remplacement ; pas une implémentation de protocole |

## SDK

Sous `packages/` se trouvent 15 packages SDK TypeScript : `core` et `backend`, plus les bindings de
framework pour React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo,
Electron et Tauri. Avec les 3 kernels runtime publics (`crypto`, `protocol`, `types`), 18 packages
sont configurés comme publiables et passent des installations propres depuis des tarballs locaux.
Les 5 autres (`db`, `i18n`, `saml`, `web-ui`, `webauthn`) sont des packages d'implémentation privés.
Le statut de publication dans le registre npm externe reste `UNKNOWN` ; une preuve de distribution
locale ne constitue pas une preuve de release dans le registre.

Treize SDK natifs sous `sdk/` : Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS,
Linux, Android et Flutter. **Aucun n'est publié sur crates.io, PyPI, Maven Central, RubyGems,
Packagist, NuGet, CocoaPods ou pub.dev**, et aucun pipeline de release n'existe pour eux -- ils se
consomment depuis les sources. La CI n'installe aucune toolchain de langage et n'exécute aucune de
leurs suites de tests. Ce qu'elle vérifie, c'est la matrice de contrat de
`tests/native-sdk-contract.test.mjs` : `pnpm check` appelle `native:verify` dans le job `check`, ce
qui vérifie que chaque entrée de plateforme de la matrice pointe vers un répertoire existant.
Exécuter la vraie toolchain d'une plateforme est une action locale volontaire :
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`. La maturité par plateforme est documentée dans
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Documentation

Commencez par [`docs/README.md`](docs/README.md), qui oriente selon le profil du lecteur. Tout le
contenu de `docs/` est rédigé en anglais, et la version anglaise fait référence. Un miroir en
chinois simplifié existe dans [`docs/zh-Hans/`](docs/zh-Hans/README.md), limité aux documents
d'entrée et aux chapitres de conception. **Il n'existe aucune traduction française de la
documentation.**

- Conception produit, neuf chapitres : [`docs/design/`](docs/design/README.md)
- Matrices de protocoles et audit des écarts : [`docs/protocols/`](docs/protocols/README.md)
- Contrats des endpoints HTTP : [`docs/api-contracts.md`](docs/api-contracts.md)
- Auto-hébergement : [`docs/deployment.md`](docs/deployment.md)
- URL faisant référence pour les standards : [`docs/standards-sources.md`](docs/standards-sources.md)

## Contribuer, sécurité et licence

Lisez [`CONTRIBUTING.md`](CONTRIBUTING.md) avant d'ouvrir une pull request ; ce document couvre la
toolchain, les contrôles obligatoires et la signature du Developer Certificate of Origin. La
participation est régie par [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), et
[`SUPPORT.md`](SUPPORT.md) traite les questions qui ne relèvent pas d'une modification de code.
N'ouvrez pas d'issue publique pour une vulnérabilité -- les canaux de signalement, le périmètre et
le calendrier de divulgation figurent dans [`SECURITY.md`](SECURITY.md).

XID est distribué sous licence MIT ; voir [`LICENSE`](LICENSE). Vous pouvez l'utiliser, le modifier
et le redistribuer, y compris à des fins commerciales et dans des produits propriétaires, tant que
vous conservez la mention de copyright et le texte de la licence.

# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Français | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

Une plateforme d'identité nativement conçue pour l'edge, déployée depuis une seule base de code sous
forme de trois Cloudflare Workers. Le Core Worker fournit OIDC/OAuth, le RBAC multi-tenant, la
fédération SSO d'entreprise, la Hosted Auth et les pages de compte. Le Nimbus Site Worker fournit
la documentation Nimbus localisée depuis l'apex, tandis qu'un Console Worker isolé fournit l'interface
de gestion.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## État du projet

**Pré-1.0.** Jusqu'à la 1.0.0, les API publiques, le schéma de base de données et les surfaces de
packages peuvent encore évoluer sans longue période de dépréciation.

Le déploiement hébergé [https://xid.dev](https://xid.dev) est en production. Les chemins first-party
Hosted Auth, Console, Management API et cœurs associés ont des preuves **production (L4)** contre ce
déploiement (voir [`docs/api-contracts.md`](docs/api-contracts.md) et les gates
`pnpm run smoke:production*`). Le reste de la matrice s'appuie encore largement sur les tests locaux
L0–L3 (unitaires, runtime Workers, navigateur ou client de protocole).

**Pas** production-supported tant qu'il n'existe pas de ligne L4 réelle pour le chemin concerné :
IdP d'entreprise (Okta, Microsoft Entra ID, etc.), SSO/SCIM SaaS aval (Slack, GitHub Enterprise,
etc.), OAuth social avec secrets et callbacks réels, livraison SMS/WhatsApp. Une implémentation
locale ou un statut `provider-ready` n'est pas une affirmation production-supported.

Les niveaux de preuve (L0 à L4) et de support par fonctionnalité sont définis dans
[`docs/protocols/README.md`](docs/protocols/README.md), qui prime sur tout résumé ici.

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

**Protocoles et fédération**

- Le serveur d'autorisation OIDC et OAuth 2.x fournit discovery, JWKS, protected-resource metadata,
  `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/end_session`, PAR, Device Flow,
  Dynamic Client Registration, CIBA, les réponses hybrid ainsi que les parcours de logout
  front-channel, back-channel et session management.
- Authorization code impose PKCE S256 et prend en charge client credentials, la rotation des
  refresh tokens avec révocation de famille en cas de rejeu et token exchange RFC 8693. Resource
  Indicators, DPoP, mTLS, JAR, JARM, RAR et les profils de policy locaux Browser-Based Apps et
  FAPI 2.0 sont implémentés.
- Le SSO d'entreprise fonctionne dans les deux sens : SAML 2.0 SP et OIDC RP entrants, SAML 2.0 IdP
  et applications OIDC sortants pour les SaaS en aval, ainsi que LDAP direct bind, WS-Federation,
  SWA password vaulting, SSO par en-têtes et un directory connector framework.
- Le SCIM 2.0 Service Provider couvre Users, Groups, PATCH, filtres, projection, tri, bulk et
  ETag/If-Match, avec provisioning sortant des Users et Groups vers les cibles SaaS.
- OpenID Federation se limite à une frontière minimale de entity metadata et registration. La
  résolution de trust chain, les trust anchors, le parcours authority-hint et l'interopérabilité
  de production ne sont pas implémentés.

**Authentification et cycle de vie du compte**

- Passkeys/WebAuthn est le credential principal, avec discoverable credentials, user verification
  obligatoire, vérification ES256/RS256/EdDSA, détection de clonage par sign-count et validation
  policy-driven de packed enterprise attestation.
- Les mots de passe utilisent Argon2id avec un pepper côté serveur dans Workers Secrets. Le
  passwordless prend en charge magic links et codes à usage unique par e-mail, SMS et WhatsApp ; le
  flux OAuth social en relying party prend en charge Google, GitHub, Microsoft account et Apple.
- La MFA couvre TOTP, SMS, passkey challenge, codes de secours à usage unique et step-up OIDC AAL2
  lié à la session courante. XID ne revendique pas AAL3.
- Le guest sign-in fournit la réutilisation paresseuse de type Firebase et l'upgrade passkey en
  place en un clic, tout en conservant `sub`. Les clients navigateur disposent aussi de la
  réauthentification silencieuse `prompt=none` par iframe cachée avec fallback par redirection
  top-level.
- Hosted Auth et le portail de compte implémentent l'acceptation d'invitation, la vérification
  d'e-mail, l'onboarding self-service d'un Tenant racine, la sélection de l'Organization active,
  la gestion des sessions et des credentials en libre-service.

**Organisations et autorisation**

- Instances, Organizations, SubOrgs sur un niveau, memberships, Projects, Applications, rôles,
  permissions, grants utilisateurs et inter-Organization, invitations et vérification de domaine.
- Les arbres OrgUnit représentent départements et équipes dans une Organization, avec affectations
  principales et secondaires, profondeur maximale de 8, déplacement et archivage de sous-arbres,
  et résolution du manager le long de la ligne hiérarchique. Une OrgUnit n'est jamais une frontière
  de tenant ni un token claim.
- Chaque Project peut être `open`, `restricted` ou `approval_required`. L'autorisation dans la même
  Organization applique cette policy ; l'utilisateur peut demander l'accès, les approvers sont
  résolus via la ligne OrgUnit puis les rôles de management, et une approbation peut créer un
  `user_grant` expirant.

**Opérations et livraison**

- Management API sous `/v1/*`, portail de compte en libre-service sous `/v1/me/*` et API opérateur
  d'instance sous `/v1/platform/*`, protégée séparément.
- Les événements d'audit append-only utilisent une chaîne SHA-256 par tenant et expurgent les
  metadata sensibles avant persistence. Huit pipelines asynchrones possèdent chacun leurs chemins
  dead-letter et quarantine avec replay sous lease ; les échecs de metering utilisent un outbox D1.
- Les webhooks signés prennent en charge secrets chiffrés, rotation, retry, message IDs idempotents
  et snapshots dead-letter. Les flux de confidentialité self-service fournissent exports R2 privés
  et erasure différé annulable, avec protection du seul owner d'Organization et du dernier instance
  manager.
- Feature flags, branding, metering, annonces, compliance artifacts et Hosted UI en 8 langues
  (en, zh-Hans, ja, ko, fr, de, es, pt-BR) sont gérés depuis la même base de code.

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

| Domaine                                                                            | Support    | Preuve la plus forte            | Notes                                                                               |
| ---------------------------------------------------------------------------------- | ---------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Noyau OAuth 2.x (code, PKCE S256, client credentials, rotation des refresh tokens) | implémenté | client de protocole local       | Les grants implicit et password sont rejetés, avec tests négatifs                   |
| Noyau OIDC (ID token, userinfo, logout, session management, hybrid)                | implémenté | client de protocole local       | Les profils de logout front-channel et back-channel sont inclus                     |
| PAR, DPoP, Device Flow                                                             | implémenté | client de protocole local       | Le nonce challenge DPoP n'est pas implémenté                                        |
| Profils d'enforcement Browser-Based Apps et FAPI 2.0                               | implémenté | intégration runtime Workers     | Preuve de policy locale uniquement, sans revendication de conformance en production |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA                                    | implémenté | intégration runtime Workers     | JWE, remote request-object fetch et `form_post.jwt` ne sont pas revendiqués         |
| OpenID Federation                                                                  | implémenté | intégration runtime Workers     | Metadata et registration minimaux uniquement, sans résolution de trust chain        |
| SAML 2.0 SP (entrant) et IdP (sortant)                                             | implémenté | faux IdP et faux SP SaaS locaux | Non vérifié face à Okta, Entra ID ou Google Workspace                               |
| SCIM 2.0 Service Provider et provisioning sortant                                  | implémenté | faux SCIM SaaS local            | Non vérifié face à un annuaire ou une cible SaaS réels                              |
| WebAuthn, passkeys, passkey MFA et step-up AAL2                                    | implémenté | intégration runtime Workers     | EdDSA et packed attestation locaux inclus, AAL3 non pris en charge                  |
| LDAP direct bind, WS-Federation, SWA, SSO par en-têtes                             | implémenté | harnais local                   | Kerberos n'existe qu'en documentation                                               |
| OAuth social en relying party (Google, GitHub, Microsoft, Apple)                   | implémenté | faux provider local             | Non vérifié avec de vrais secrets ni de vrais callbacks de provider                 |
| Shared Signals, CAEP, RISC                                                         | planifié   | tests négatifs de routes        | Les endpoints renvoient 501 et ne créent aucun stream                               |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                                  | planifié   | tests négatifs de routes        | Les routes réservées renvoient 501 et ne sont pas des implémentations de protocoles |

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

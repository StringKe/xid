# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | Español | [Português (BR)](README.pt-BR.md)

Una plataforma de identidad nativa del edge desplegada como tres Cloudflare Workers desde una sola
base de código. El Core Worker sirve OIDC/OAuth, RBAC multi-tenant, federación SSO empresarial,
Hosted Auth y páginas de cuenta. El Nimbus Site Worker sirve la documentación Nimbus localizada
desde apex, mientras que un Console Worker aislado sirve la interfaz de gestión.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

## Estado del proyecto

**Pre-1.0. Todavía no lo pongas en producción.** Cada capacidad descrita más abajo se apoya
únicamente en evidencia local: tests unitarios, tests de integración sobre el runtime de Workers y
pruebas de humo con navegador o con clientes de protocolo contra una build local. Nada se ha
verificado de extremo a extremo contra un proveedor de identidad externo real, una aplicación SaaS
downstream real, un proveedor OAuth social real ni una entrega real por SMS/WhatsApp. Los niveles de
evidencia (L0 a L4) y los niveles de soporte por funcionalidad están definidos en
[`docs/protocols/README.md`](docs/protocols/README.md), que prevalece sobre cualquier resumen de
esta página. Las interfaces, el esquema de base de datos y las APIs de los paquetes pueden cambiar
sin periodo de deprecación.

## Por qué XID

Las peticiones de identidad son críticas en latencia y están distribuidas globalmente, y aun así la
mayoría de plataformas de identidad las resuelve desde una sola región. XID coloca el servidor de
autorización completo en el edge de Cloudflare: la firma de tokens se ejecuta sobre Web Crypto
dentro del isolate, la revocación de sesiones se serializa mediante un Durable Object por usuario en
lugar de una base de datos central, y JWKS se cachea en KV para que las relying parties verifiquen
tokens sin viaje de ida y vuelta. El multi-tenancy tampoco es un añadido -- issuer, claves de firma,
RP ID de WebAuthn y políticas se resuelven desde un único `TenantContext`, de modo que el mismo
árbol de fuentes funciona como despliegue single-tenant sin configuración o como instancia
multi-tenant, según la configuración y no según un flag de build.

## Funcionalidades

**Superficie de protocolo**

- Servidor de autorización OIDC y OAuth 2.x: discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, registro dinámico de
  clientes (RFC 7591/7592) y autenticación backchannel CIBA.
- Authorization code con PKCE S256 obligatorio, client credentials, device code, rotación de refresh
  con revocación de la familia ante replay, e intercambio de tokens RFC 8693. Tokens vinculados al
  emisor mediante DPoP y mTLS; request objects firmados (JAR) y respuestas de autorización firmadas
  (JARM).
- SSO empresarial en ambos sentidos: federación entrante como SP SAML 2.0 y como RP OIDC, IdP SAML
  2.0 saliente para SaaS downstream, además de bind directo LDAP, WS-Federation, almacenamiento de
  contraseñas SWA y SSO por cabeceras.
- Service Provider SCIM 2.0 (Users, Groups, PATCH, filtros, ordenación, bulk, ETag/If-Match) más
  aprovisionamiento saliente hacia destinos SaaS downstream.

**Autenticación**

- Passkeys/WebAuthn como credencial principal: credenciales descubribles, verificación de usuario
  obligatoria, detección de clonado por sign-count.
- Contraseñas con hash Argon2id más un pepper de servidor guardado en Workers Secrets; magic links;
  códigos de un solo uso por email, SMS y WhatsApp; OAuth social actuando como relying party.
- MFA con TOTP, SMS, passkey como segundo factor y códigos de respaldo de un solo uso.

**Plataforma**

- Organizaciones, membresías, roles, permisos, invitaciones y verificación de dominios.
- Management API bajo `/v1/*`, portal de cuenta self-service bajo `/v1/me/*`, API del operador de la
  instancia bajo `/v1/platform/*`.
- Registro de auditoría append-only con hashes SHA-256 encadenados, webhooks firmados con cola de
  mensajes muertos, feature flags y medición de uso.
- Hosted UI en 8 idiomas (en, zh-Hans, ja, ko, fr, de, es, pt-BR) con los catálogos completamente
  traducidos.

## Inicio rápido

### Integrar una aplicación

Dieciocho paquetes TypeScript `@xid-kit/*` están configurados como publicables y superan el gate
de consumo de tarballs locales limpios (`pnpm run sdk:distribution:verify`). El repositorio no
contiene evidencia de release que pruebe su estado actual en un registro externo, por lo que el
estado de publicación en npm es `UNKNOWN`; usa el workspace o un tarball generado localmente salvo
que verifiques el registro por separado. La API siguiente es la superficie pública actual. Desde
`@xid-kit/react`:

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

Dentro del provider, `useUser()` devuelve una unión discriminada sobre `isLoaded` e `isSignedIn`, y
`useAuth()` expone `getToken` y `signOut`; los hooks de organización, sesión y API key siguen la
misma forma. En el servidor, `verifyToken` de `@xid-kit/backend` funciona sin red -- le pasas el
JWKS que ya tienes y nada sale del isolate.

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

`authenticateRequest(request, options)` envuelve la misma comprobación para un `Request` completo, y
`verifyWebhook(request, options)` valida las firmas de los webhooks entrantes.

### Autoalojamiento

Requiere Node >= 22.12 y pnpm 10.33.4. D1, KV, Queues y los Durable Objects respaldados por SQLite
tienen plan gratuito en Workers, pero enviar correo a destinatarios arbitrarios a través del binding
`send_email` requiere Workers Paid, así que cualquier despliegue que realmente entregue correos de
verificación, magic links o códigos de un solo uso necesita el plan de pago.

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

El script de Queue deriva los 24 recursos necesarios de `apps/server/wrangler.jsonc`: 8 Queues
de origen, 8 dead-letter Queues por origen y 8 Queues de cuarentena por fallos de persistencia.
No crea el `xid-dlq` compartido y obsoleto.

Después sustituye los valores upstream de account y routes en `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc` y `apps/site/wrangler.jsonc`. También configura el origen público
canónico de `apps/site/astro.config.ts` con tu URL HTTPS apex. La configuración de Core también
necesita tu `database_id` de D1 y el `id` del namespace de KV. No hay una plantilla de
autoalojamiento que copiar y **los tres Workers no se desplegarán correctamente mientras conserven
los valores upstream**. Los once bindings de Durable Object, el dataset de Analytics Engine, el
binding `send_email` y los dos cron triggers pertenecen solo a Core y ya están declarados.

Configura los secretos, verifica en local, conecta Workers Builds e inicializa cuando las tres builds
de producción hayan terminado correctamente. Perder `KEK` deja indescifrable cada clave de firma y
cada credencial de proveedor almacenada; perder `PEPPER` invalida todos los hashes de contraseña.
Haz una copia de seguridad de ambos fuera de Cloudflare antes de empezar.

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

Conecta `xid`, `xid-console` y `xid-site` como tres proyectos de Cloudflare Workers Builds respaldados
por este repositorio Git. Configura `main` como branch de producción, desactiva las builds de branches
no productivos y las Worker Preview URLs, y usa los comandos de root, build y deploy de
[`docs/deployment.md`](docs/deployment.md). Fusiona en `main` un commit revisado y firmado; Workers
Builds aplica las migraciones remotas de D1 y despliega los tres Workers. Cuando terminen las builds:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

El bootstrap crea la instancia, la organización por defecto, la clave de firma ES256 de la instancia
y el primer usuario `instance_manager`; se niega a ejecutarse dos veces. Las instrucciones
completas, incluidas la migración local de D1, el seeding, el orden de release de los tres Workers y
el rollback, están en [`docs/deployment.md`](docs/deployment.md). Un release autoalojado debe
desplegar Core, Console y Site. Site gestiona apex, docs en 8 locales, SEO, Pagefind, agent surfaces
y el 308 de `www`; Console gestiona `/console` y `/console/*`.

### Desarrollo

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` es el control completo, con dos pasadas de cobertura incluidas; no es un lint
rápido. Invoca `native:verify`, que sin `XID_NATIVE_SDK_PLATFORM` definido solo valida la matriz de
contrato de los SDKs nativos y no necesita ninguna toolchain nativa. GitHub Actions verifica pero
nunca despliega; el despliegue de producción se ejecuta desde Cloudflare Workers Builds en la cuenta
del propietario del repositorio. Consulta [`CONTRIBUTING.md`](CONTRIBUTING.md) para el flujo de
trabajo de cada área.

## Arquitectura

Tres Workers comparten un hostname sin compartir runtime bindings. Nimbus Site gestiona el hub de
documentación apex, los 8 árboles de documentación localizada, SEO, Pagefind, los twins Markdown y MDX, los LLM
indexes y el 308 de `www` a apex. Console es un Worker estático sin bindings que gestiona
`/console` y `/console/*` en los hosts apex y tenant. Core gestiona Hosted Auth, páginas de cuenta,
rutas de protocolo y API, y `/_core/*`; es el único Worker con bindings de D1, Durable Objects, KV,
R2, Queues, email, Analytics Engine y cron.

El estado de Core se reparte según el requisito de consistencia: D1 para datos relacionales, Durable
Objects para todo lo que necesite serialización (challenges de WebAuthn, estado OAuth, PAR, device
flow, revocación de sesiones, límites de tasa, secuencia de auditoría, medición), KV para lecturas
cacheadas, R2 para blobs y Queues para el trabajo que debe mantenerse fuera de la ruta de login.

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

Los kernels públicos de runtime son `protocol`, `crypto` y `types`. Los paquetes privados de
implementación son `webauthn`, `saml`, `db`, `i18n` y `web-ui`. Las primitivas criptográficas
provienen siempre de Web Crypto y XML-DSig se delega en `xmldsigjs`; el protocolo y la lógica de
negocio intermedios se escriben aquí.

## Soporte de protocolos

Cada fila se corresponde con archivos y tests en
[`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Área                                                                           | Soporte      | Evidencia máxima                     | Notas                                                                                       |
| ------------------------------------------------------------------------------ | ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Núcleo de OAuth 2.x (code, PKCE S256, client credentials, rotación de refresh) | implementado | cliente de protocolo local           | Los grants implicit y password se rechazan con tests negativos                              |
| Núcleo de OIDC (ID token, userinfo, logout, gestión de sesión, hybrid)         | implementado | cliente de protocolo local           | Incluye los perfiles de logout front-channel y back-channel                                 |
| PAR, DPoP, device flow                                                         | implementado | cliente de protocolo local           | El nonce challenge de DPoP no está implementado                                             |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA, OpenID Federation             | implementado | integración en el runtime de Workers | No se afirma soporte de JWE, descarga remota del request object ni `form_post.jwt`          |
| SAML 2.0 SP (entrante) e IdP (saliente)                                        | implementado | IdP falso local y SP SaaS falso      | Sin verificar contra Okta, Entra ID ni Google Workspace                                     |
| Service Provider SCIM 2.0 y aprovisionamiento saliente                         | implementado | SCIM SaaS falso local                | Sin verificar contra un directorio o destino SaaS real                                      |
| WebAuthn / passkeys                                                            | implementado | integración en el runtime de Workers | Verificación en cuatro pasos sin ninguna ruta de omisión                                    |
| Bind directo LDAP, WS-Federation, SWA, SSO por cabeceras                       | implementado | harness local                        | Kerberos es solo documentación                                                              |
| Relying party de OAuth social (Google, GitHub, Microsoft, Apple)               | implementado | proveedor falso local                | Sin verificar con secretos ni callbacks de proveedores reales                               |
| Shared Signals, CAEP, RISC                                                     | planificado  | tests unitarios                      | Los endpoints devuelven 501 y no crean ningún stream                                        |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                              | stub         | integración en el runtime de Workers | Rutas stub que devuelven 501 o un objeto de relleno; no es una implementación del protocolo |

## SDKs

Bajo `packages/` hay 15 paquetes SDK TypeScript: `core` y `backend` más los bindings de framework
para React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron
y Tauri. Junto con los 3 kernels públicos de runtime (`crypto`, `protocol`, `types`), 18 paquetes
están configurados como publicables y pasan instalaciones limpias desde tarballs locales. Los
otros 5 (`db`, `i18n`, `saml`, `web-ui`, `webauthn`) son paquetes privados de implementación. El
estado de publicación en el registro externo de npm sigue siendo `UNKNOWN`; la evidencia de
distribución local no demuestra un release en el registro.

Trece SDKs nativos bajo `sdk/`: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS, Linux,
Android y Flutter. **Ninguno se publica en crates.io, PyPI, Maven Central, RubyGems, Packagist,
NuGet, CocoaPods ni pub.dev**, y no existe ningún pipeline de release para ellos -- se consumen
desde el código fuente. CI no instala ninguna toolchain de lenguaje ni ejecuta sus suites de tests.
Lo que sí comprueba es la matriz de contrato de `tests/native-sdk-contract.test.mjs`: `pnpm check`
invoca `native:verify` dentro del job `check`, y eso verifica que cada entrada de plataforma de la
matriz apunta a un directorio que existe. Ejecutar la toolchain real de una plataforma es un paso
local opcional: `XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`. La madurez por plataforma está
en [`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Documentación

Empieza por [`docs/README.md`](docs/README.md), que enruta según el tipo de lector. Todo lo que hay
bajo `docs/` está escrito en inglés, y la versión inglesa es la autoritativa. Existe un espejo en
chino simplificado en [`docs/zh-Hans/`](docs/zh-Hans/README.md), limitado a los documentos de
entrada y a los capítulos de diseño. **No hay traducción de la documentación al español.**

- Diseño de producto, nueve capítulos: [`docs/design/`](docs/design/README.md)
- Matrices de protocolo y auditoría de carencias: [`docs/protocols/`](docs/protocols/README.md)
- Contratos de los endpoints HTTP: [`docs/api-contracts.md`](docs/api-contracts.md)
- Autoalojamiento: [`docs/deployment.md`](docs/deployment.md)
- URLs fuente de verdad de los estándares: [`docs/standards-sources.md`](docs/standards-sources.md)

## Contribuir, seguridad y licencia

Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de abrir una pull request; cubre la toolchain, los
controles obligatorios y la firma del Developer Certificate of Origin. La participación se rige por
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), y [`SUPPORT.md`](SUPPORT.md) cubre las preguntas que no
son cambios de código. No abras un issue público para una vulnerabilidad -- los canales de reporte,
el alcance y los plazos de divulgación están en [`SECURITY.md`](SECURITY.md).

XID se distribuye bajo la licencia MIT; consulta [`LICENSE`](LICENSE). Puedes usarlo, modificarlo y
distribuirlo, incluso comercialmente y en productos de código cerrado, siempre que conserves el
aviso de copyright y el texto de la licencia.

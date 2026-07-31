# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | Português (BR)

Uma plataforma de identidade nativa de edge implantada como três Cloudflare Workers a partir de uma
só base de código. O Core Worker fornece OIDC/OAuth, RBAC multi-tenant, federação de SSO corporativo,
Hosted Auth e páginas de conta. O Nimbus Site Worker fornece a documentação Nimbus localizada
diretamente no apex, enquanto um Console Worker isolado fornece a interface de gestão.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

## Situação do projeto

**Pré-1.0. Ainda não coloque isto em produção.** Todos os recursos abaixo têm como respaldo apenas
evidências locais: testes unitários, testes de integração no runtime dos Workers e smoke tests via
navegador ou cliente de protocolo contra um build local. Nada foi verificado de ponta a ponta contra
um provedor de identidade externo real, uma aplicação SaaS downstream real, um provedor OAuth social
real ou entrega real de SMS/WhatsApp. Os níveis de evidência (L0 a L4) e o grau de suporte por
recurso estão definidos em [`docs/protocols/README.md`](docs/protocols/README.md), que prevalece
sobre qualquer resumo apresentado aqui. Interfaces, schema de banco de dados e APIs dos pacotes podem
mudar sem período de depreciação.

## Por que o XID

Requisições de identidade são críticas em latência e distribuídas globalmente, mas a maioria das
plataformas de identidade as atende a partir de uma única região. O XID coloca o servidor de
autorização inteiro na edge da Cloudflare: a assinatura de tokens roda em Web Crypto dentro do
isolate, a revogação de sessão é serializada por um Durable Object por usuário em vez de um banco de
dados central, e o JWKS fica em cache no KV para que as relying parties validem tokens sem
round trip. A multi-tenancy também não é um complemento -- issuer, chaves de assinatura, RP ID do
WebAuthn e políticas são todos resolvidos a partir de um único `TenantContext`, de modo que a mesma
árvore de código roda como deployment single-tenant sem configuração ou como instância multi-tenant,
por configuração e não por flag de build.

## Recursos

**Superfície de protocolo**

- Servidor de autorização OIDC e OAuth 2.x: discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, registro dinâmico de
  clientes (RFC 7591/7592) e autenticação backchannel CIBA.
- Authorization code com PKCE S256 obrigatório, client credentials, device code, rotação de refresh
  com revogação de family em caso de replay e token exchange (RFC 8693). Tokens sender-constrained
  via DPoP e mTLS; request objects assinados (JAR) e authorization responses assinadas (JARM).
- SSO corporativo nos dois sentidos: federação de entrada como SP SAML 2.0 e RP OIDC, IdP SAML 2.0
  de saída para SaaS downstream, além de LDAP direct bind, WS-Federation, SWA password vaulting e
  SSO baseado em header.
- Service Provider SCIM 2.0 (Users, Groups, PATCH, filtros, ordenação, bulk, ETag/If-Match) e
  provisionamento de saída para destinos SaaS downstream.

**Autenticação**

- Passkeys/WebAuthn como credencial principal: discoverable credentials, user verification
  obrigatória, detecção de clonagem por sign-count.
- Senhas com hash Argon2id e pepper do lado do servidor guardado em Workers Secrets; magic links;
  códigos de uso único por e-mail, SMS e WhatsApp; OAuth social atuando como relying party.
- MFA com TOTP, SMS, passkey como segundo fator e backup codes de uso único.

**Plataforma**

- Organizações, memberships, papéis, permissões, convites e verificação de domínio.
- Management API em `/v1/*`, portal self-service da conta em `/v1/me/*` e API do operador da
  instância em `/v1/platform/*`.
- Log de auditoria append-only com hashes SHA-256 encadeados, webhooks assinados com dead-letter
  queue, feature flags e medição de uso.
- Hosted UI em 8 idiomas (en, zh-Hans, ja, ko, fr, de, es, pt-BR) com catálogos totalmente
  traduzidos.

## Início rápido

### Integrando uma aplicação

Dezoito pacotes TypeScript `@xid-kit/*` estão configurados como publicáveis e passam pelo gate de
consumo de tarballs locais limpos (`pnpm run sdk:distribution:verify`). O repositório não contém
evidência de release que comprove o estado atual em um registry externo, então o estado de
publicação no npm é `UNKNOWN`; use o workspace ou um tarball gerado localmente, a menos que você
verifique o registry separadamente. A API abaixo é a superfície pública atual. De
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

Dentro do provider, `useUser()` retorna uma união discriminada por `isLoaded` e `isSignedIn`, e
`useAuth()` expõe `getToken` e `signOut`; os hooks de organização, sessão e API key seguem o mesmo
formato. No lado do servidor, `verifyToken` de `@xid-kit/backend` é networkless -- passe o JWKS que
você já tem em mãos e nada sai do isolate.

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

`authenticateRequest(request, options)` encapsula a mesma verificação para um `Request` inteiro, e
`verifyWebhook(request, options)` valida assinaturas de webhooks recebidos.

### Self-hosting

Requer Node >= 22.12 e pnpm 10.33.4. D1, KV, Queues e Durable Objects com backend SQLite têm camada
gratuita nos Workers, mas enviar e-mail para destinatários arbitrários pelo binding `send_email`
exige o plano Workers Paid, então qualquer deployment que de fato entregue e-mails de verificação,
magic links ou códigos de uso único precisa do plano pago.

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

O script de Queue deriva os 24 recursos necessários de `apps/server/wrangler.jsonc`: 8 Queues de
origem, 8 dead-letter Queues específicas por origem e 8 Queues de quarentena para falhas de
persistência. Ele não cria o `xid-dlq` compartilhado e obsoleto.

Em seguida substitua os valores upstream de account e routes em `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc` e `apps/site/wrangler.jsonc`. Defina também a origem pública canônica
em `apps/site/astro.config.ts` para sua URL HTTPS apex. A configuração do Core também precisa do
`database_id` do D1 e do `id` do namespace KV. Não existe template de self-hosting para copiar e
**os três Workers não serão implantados corretamente enquanto esses valores upstream permanecerem**.
Os onze bindings de Durable Object, o dataset do Analytics Engine, o binding `send_email` e os dois
cron triggers pertencem somente ao Core e já estão declarados.

Defina os secrets, verifique localmente, conecte o Workers Builds e inicialize depois que os três
builds de produção forem concluídos com sucesso. Perder `KEK` torna indecifrável toda chave de
assinatura e toda credencial de provider armazenada; perder `PEPPER` invalida todos os hashes de
senha. Faça backup dos dois fora da Cloudflare antes de qualquer coisa.

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

Conecte `xid`, `xid-console` e `xid-site` como três projetos do Cloudflare Workers Builds vinculados a
este repositório Git. Defina `main` como branch de produção, desative builds de branches não produtivos
e as Worker Preview URLs, e use os comandos de root, build e deploy de
[`docs/deployment.md`](docs/deployment.md). Faça merge em `main` de um commit revisado e assinado;
Workers Builds aplica as migrations remotas do D1 e implanta os três Workers. Após os builds:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

O bootstrap cria a instância, a organização padrão, a chave de assinatura ES256 da instância e o
primeiro usuário `instance_manager`; ele se recusa a rodar duas vezes. As instruções completas,
incluindo migração e seed do D1 local, ordem de release dos três Workers e rollback, estão em
[`docs/deployment.md`](docs/deployment.md). Um release self-hosted precisa implantar Core, Console e
Site. Site cuida do apex, docs em 8 locales, SEO, Pagefind, agent surfaces e do 308 de `www`;
Console cuida de `/console` e `/console/*`.

### Desenvolvimento

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` é o gate completo, incluindo duas rodadas de cobertura; não é um lint rápido. Ele
chama `native:verify`, que sem `XID_NATIVE_SDK_PLATFORM` definido apenas valida a matriz de contrato
dos SDKs nativos e não exige toolchain nativa. O GitHub Actions verifica mas nunca faz deploy; o
deployment de produção roda a partir do Cloudflare Workers Builds na conta do dono do repositório.
Veja [`CONTRIBUTING.md`](CONTRIBUTING.md) para o fluxo de trabalho de cada área.

## Arquitetura

Três Workers compartilham um hostname sem compartilhar runtime bindings. Nimbus Site cuida do
hub de documentação apex, das 8 árvores de documentação localizada, SEO, Pagefind, twins Markdown e MDX, LLM
indexes e do 308 de `www` para apex. Console é um Worker estático sem bindings que cuida de
`/console` e `/console/*` nos hosts apex e tenant. Core cuida de Hosted Auth, páginas de conta,
rotas de protocolo e API, e `/_core/*`; é o único Worker com bindings D1, Durable Objects, KV, R2,
Queues, email, Analytics Engine e cron.

O estado do Core é dividido por requisito de consistência: D1 para dados relacionais, Durable
Objects para tudo que precisa de serialização (challenges WebAuthn, state OAuth, PAR, device flow,
revogação de sessão, rate limits, sequência de auditoria, medição), KV para leituras em cache, R2
para blobs e Queues para trabalho que precisa ficar fora do caminho de login.

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

Os kernels públicos de runtime são `protocol`, `crypto` e `types`. Os pacotes privados de
implementação são `webauthn`, `saml`, `db`, `i18n` e `web-ui`. As primitivas criptográficas vêm
sempre do Web Crypto e o XML-DSig é delegado ao `xmldsigjs`; o protocolo e a lógica de negócio
entre eles são escritos aqui.

## Suporte a protocolos

Cada linha está mapeada a arquivos e testes em
[`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Área                                                                       | Suporte      | Evidência mais alta               | Observações                                                                               |
| -------------------------------------------------------------------------- | ------------ | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Núcleo OAuth 2.x (code, PKCE S256, client credentials, rotação de refresh) | implementado | cliente de protocolo local        | Os grants implicit e password são rejeitados, com testes negativos                        |
| Núcleo OIDC (ID token, userinfo, logout, session management, hybrid)       | implementado | cliente de protocolo local        | Inclui os perfis de logout front-channel e back-channel                                   |
| PAR, DPoP, device flow                                                     | implementado | cliente de protocolo local        | O nonce challenge do DPoP não está implementado                                           |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA, OpenID Federation         | implementado | integração no runtime dos Workers | JWE, busca remota de request object e `form_post.jwt` não são reivindicados               |
| SAML 2.0 SP (entrada) e IdP (saída)                                        | implementado | IdP falso e SP SaaS falso locais  | Não verificado contra Okta, Entra ID ou Google Workspace                                  |
| Service Provider SCIM 2.0 e provisionamento de saída                       | implementado | SCIM SaaS falso local             | Não verificado contra um diretório ou destino SaaS real                                   |
| WebAuthn / passkeys                                                        | implementado | integração no runtime dos Workers | Verificação em quatro etapas, sem caminho de bypass                                       |
| LDAP direct bind, WS-Federation, SWA, SSO baseado em header                | implementado | harness local                     | Kerberos existe apenas na documentação                                                    |
| Relying party de OAuth social (Google, GitHub, Microsoft, Apple)           | implementado | provider falso local              | Não verificado com secrets ou callbacks de provider reais                                 |
| Shared Signals, CAEP, RISC                                                 | planejado    | testes unitários                  | Os endpoints retornam 501 e não criam streams                                             |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                          | stub         | integração no runtime dos Workers | Stubs de rota que retornam 501 ou um objeto placeholder; não é implementação de protocolo |

## SDKs

Há 15 pacotes SDK TypeScript em `packages/`: `core` e `backend` mais bindings de framework para
React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron e
Tauri. Com os 3 kernels públicos de runtime (`crypto`, `protocol`, `types`), 18 pacotes estão
configurados como publicáveis e passam por instalações limpas a partir de tarballs locais. Os
outros 5 (`db`, `i18n`, `saml`, `web-ui`, `webauthn`) são pacotes privados de implementação. O
estado de publicação no registry externo do npm permanece `UNKNOWN`; evidência de distribuição
local não comprova um release no registry.

Treze SDKs nativos em `sdk/`: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS, Linux,
Android e Flutter. **Nenhum é publicado em crates.io, PyPI, Maven Central, RubyGems, Packagist,
NuGet, CocoaPods ou pub.dev**, e não existe pipeline de release para eles -- são consumidos a partir
do código-fonte. A CI não instala nenhuma toolchain de linguagem e não roda nenhuma dessas suítes de
testes. O que ela verifica é a matriz de contrato em `tests/native-sdk-contract.test.mjs`:
`pnpm check` chama `native:verify` dentro do job `check`, e isso confere que cada entrada de
plataforma da matriz aponta para um diretório que existe. Executar a toolchain real de uma
plataforma é um passo local opcional: `XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`. A
maturidade por plataforma está em [`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Documentação

Comece por [`docs/README.md`](docs/README.md), que direciona conforme o perfil do leitor. Tudo em
`docs/` está escrito em inglês, e a versão em inglês é a autoritativa. Existe um espelho em chinês
simplificado em [`docs/zh-Hans/`](docs/zh-Hans/README.md), restrito aos documentos de entrada e aos
capítulos de design. **Não existe tradução da documentação para português.**

- Design de produto, nove capítulos: [`docs/design/`](docs/design/README.md)
- Matrizes de protocolo e auditoria de lacunas: [`docs/protocols/`](docs/protocols/README.md)
- Contratos dos endpoints HTTP: [`docs/api-contracts.md`](docs/api-contracts.md)
- Self-hosting: [`docs/deployment.md`](docs/deployment.md)
- URLs de referência dos padrões: [`docs/standards-sources.md`](docs/standards-sources.md)

## Contribuição, segurança e licença

Leia [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de abrir um pull request; o documento cobre a
toolchain, os gates obrigatórios e a assinatura do Developer Certificate of Origin. A participação é
regida pelo [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), e o [`SUPPORT.md`](SUPPORT.md) trata de
dúvidas que não são mudanças de código. Não abra uma issue pública para uma vulnerabilidade -- os
canais de report, o escopo e o prazo de divulgação estão em [`SECURITY.md`](SECURITY.md).

O XID é licenciado sob a MIT License; veja [`LICENSE`](LICENSE). Você pode usar, modificar e
distribuir, inclusive comercialmente e em produtos de código fechado, desde que mantenha o aviso de
copyright e o texto da licença.

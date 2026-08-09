# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | 한국어 | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

하나의 코드베이스에서 3개의 Cloudflare Workers로 배포하는 엣지 네이티브 아이덴티티 플랫폼입니다.
Core Worker는 OIDC/OAuth, 멀티 테넌트 RBAC, 엔터프라이즈 SSO 페더레이션, Hosted Auth, 계정 페이지를
제공합니다. Nimbus Site Worker는 apex 루트의 완전한 다국어 문서를, 분리된 Console Worker는 관리 UI를
제공합니다.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## 프로젝트 상태

**Pre-1.0 단계입니다. 아직 프로덕션에서 사용하지 마십시오.** 아래의 모든 기능은 로컬 근거만
확보한 상태입니다. 즉 유닛 테스트, Workers 런타임 통합 테스트, 그리고 로컬 빌드를 대상으로 한
브라우저 또는 프로토콜 클라이언트 스모크 테스트뿐입니다. 실제 외부 Identity Provider, 실제 하위
SaaS 애플리케이션, 실제 소셜 OAuth provider, 실제 SMS/WhatsApp 발송에 대해 종단 간으로 검증된
항목은 없습니다. 근거 등급(L0에서 L4까지)과 기능별 지원 수준은
[`docs/protocols/README.md`](docs/protocols/README.md)에 정의되어 있으며, 이 문서의 요약보다 해당
문서가 우선합니다. 인터페이스, 데이터베이스 스키마, 패키지 API는 deprecation 기간 없이 변경될 수
있습니다.

## XID를 만든 이유

인증 요청은 지연 시간에 민감하고 전 세계에 분산되어 발생하지만, 대부분의 아이덴티티 플랫폼은
이를 한 리전에서 처리합니다. XID는 authorization server 전체를 Cloudflare 엣지에 올립니다. 토큰
서명은 isolate 내부의 Web Crypto에서 수행되고, 세션 폐기는 중앙 데이터베이스가 아니라 사용자별
Durable Object가 직렬화하며, JWKS는 KV에 캐시되어 Relying Party가 라운드 트립 없이 토큰을 검증합니다.
멀티 테넌시도 부가 기능이 아닙니다. issuer, 서명 키, WebAuthn RP ID, 정책이 모두 하나의
`TenantContext`에서 해석되므로, 동일한 소스 트리가 빌드 플래그가 아닌 설정만으로 무설정 단일 테넌트
배포로도, 멀티 테넌트 인스턴스로도 동작합니다.

## 기능

**프로토콜 및 페더레이션**

- OIDC 및 OAuth 2.x authorization server는 discovery, JWKS, protected-resource metadata,
  `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/end_session`, PAR, Device Flow,
  Dynamic Client Registration, CIBA, hybrid response와 front-channel, back-channel,
  session-management logout 경로를 제공합니다.
- PKCE S256을 강제하는 authorization code, client credentials, family replay 시 폐기되는 refresh token
  rotation, RFC 8693 token exchange를 구현합니다. Resource Indicators, DPoP, mTLS, JAR, JARM, RAR와
  로컬 Browser-Based Apps 및 FAPI 2.0 policy profile도 구현되어 있습니다.
- 양방향 엔터프라이즈 SSO로 인바운드 SAML 2.0 SP 및 OIDC RP 페더레이션, 하위 SaaS용 아웃바운드
  SAML 2.0 IdP와 OIDC application, LDAP direct bind, WS-Federation, SWA 패스워드 볼팅, 헤더 기반
  SSO, directory connector framework를 제공합니다.
- SCIM 2.0 Service Provider는 Users, Groups, PATCH, filter, projection, sort, bulk, ETag/If-Match를
  지원하며 하위 SaaS 대상으로 Users/Groups 아웃바운드 프로비저닝도 제공합니다.
- OpenID Federation은 최소 entity metadata와 registration boundary만 구현합니다. Trust-chain
  resolution, trust anchor, authority-hint traversal, 프로덕션 상호 운용성은 구현되지 않았습니다.

**인증 및 계정 수명 주기**

- 주 자격 증명인 passkey/WebAuthn은 discoverable credential, user verification 강제,
  ES256/RS256/EdDSA 검증, sign-count 복제 감지, 정책 기반 packed enterprise attestation 검증을
  제공합니다.
- 비밀번호는 Workers Secrets의 서버 측 pepper와 Argon2id를 사용합니다. Passwordless 로그인은 magic
  link와 이메일/SMS/WhatsApp 일회용 코드를 지원하고, 소셜 OAuth relying-party flow는 Google,
  GitHub, Microsoft account, Apple을 지원합니다.
- MFA는 TOTP, SMS, passkey challenge, 일회용 backup code와 현재 session에 바인딩된 OIDC AAL2
  step-up을 제공합니다. AAL3 지원은 주장하지 않습니다.
- Guest 로그인은 Firebase-style lazy reuse와 `sub`를 유지하는 one-click in-place passkey upgrade를
  제공합니다. 브라우저 클라이언트는 hidden-iframe `prompt=none` silent re-authentication과 top-level
  redirect fallback도 제공합니다.
- Hosted Auth와 account portal에는 invitation acceptance, email verification, top-level Tenant
  onboarding, active Organization selection, session management, self-service credential management가
  구현되어 있습니다.

**조직 및 권한 부여**

- Instance, Organization, 한 단계 SubOrg, membership, Project, Application, role, permission, 사용자 및
  cross-Organization grant, invitation, domain verification을 제공합니다.
- OrgUnit tree는 Organization 내부의 부서와 팀을 표현하며 primary/secondary placement, 최대 깊이 8,
  subtree move와 archive, reporting line 기반 manager resolution을 지원합니다. OrgUnit은 tenant
  boundary나 token claim이 되지 않습니다.
- 각 Project는 `open`, `restricted`, `approval_required` 중 하나로 설정할 수 있습니다. 동일
  Organization의 authorization은 이 policy를 강제하고, 사용자는 access를 요청할 수 있습니다.
  Approver는 OrgUnit reporting line과 management fallback으로 결정되며 승인 시 만료되는
  `user_grant`를 만들 수 있습니다.

**운영 및 전송**

- `/v1/*`의 Management API, `/v1/me/*`의 self-service account portal, 별도로 보호되는
  `/v1/platform/*`의 instance-operator API를 제공합니다.
- Append-only audit event는 tenant별 SHA-256 hash chain을 사용하고 저장 전에 민감한 metadata를
  redact합니다. 8개 async pipeline은 독립된 dead-letter 및 quarantine path와 lease-based replay를
  가지며 metering 실패는 D1 outbox로 fallback합니다.
- Signed webhook은 encrypted secret, rotation, retry, idempotent message ID, dead-letter snapshot을
  지원합니다. Self-service privacy flow는 private R2 export와 취소 가능한 delayed erasure를 제공하며
  유일한 Organization owner와 마지막 instance manager를 보호합니다.
- Feature flag, branding, usage metering, announcement, compliance artifact와 8개 로케일
  (en, zh-Hans, ja, ko, fr, de, es, pt-BR)의 Hosted UI를 동일 codebase에서 관리합니다.

## 빠른 시작

### 애플리케이션 연동

18개의 `@xid-kit/*` TypeScript 패키지는 publishable로 설정되어 있으며 깨끗한 로컬 tarball consumer
gate(`pnpm run sdk:distribution:verify`)를 통과합니다. 외부 registry의 현재 상태를 입증하는 release
evidence는 저장소에 없으므로 npm 배포 상태는 `UNKNOWN`입니다. registry를 별도로 검증하지 않았다면
workspace 또는 로컬에서 만든 tarball을 사용해야 합니다. 아래 API가 현재의 공개 표면입니다.
`@xid-kit/react`에서:

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

provider 내부에서 `useUser()`는 `isLoaded`와 `isSignedIn`을 판별자로 하는 discriminated union을
반환하고, `useAuth()`는 `getToken`과 `signOut`을 노출합니다. 조직, 세션, API 키 훅도 같은 형태를
따릅니다. 서버 측에서는 `@xid-kit/backend`의 `verifyToken`이 networkless로 동작합니다. 이미 보유한
JWKS를 넘기면 isolate 밖으로 나가는 통신이 전혀 없습니다.

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

`authenticateRequest(request, options)`는 동일한 검사를 `Request` 전체에 대해 감싸 수행하고,
`verifyWebhook(request, options)`는 인바운드 webhook 서명을 검증합니다.

### 셀프 호스팅

Node 22.12 이상과 pnpm 10.33.4가 필요합니다. D1, KV, Queues, SQLite 기반 Durable Object는 모두
Workers Free 티어를 제공하지만, `send_email` binding으로 임의의 수신자에게 메일을 보내려면 Workers
Paid가 필요합니다. 따라서 실제로 검증 메일, magic link, 일회용 코드를 발송하는 배포라면 유료
플랜이 필요합니다.

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

Queue script는 `apps/server/wrangler.jsonc`에서 필요한 24개 resource를 도출합니다. source Queue
8개, source별 dead-letter Queue 8개, persistence failure quarantine Queue 8개이며, 폐기된 공유
`xid-dlq`는 만들지 않습니다.

그다음 `apps/server/wrangler.jsonc`, `apps/console/wrangler.jsonc`,
`apps/site/wrangler.jsonc`의 업스트림 account와 route 값을 자신의 값으로 교체하고,
`apps/site/astro.config.ts`의 canonical public origin을 자신의 HTTPS apex URL로 설정하십시오. Core
설정에는 D1 `database_id`와 KV namespace `id`도 필요합니다. 셀프 호스팅 템플릿은 없으며, **업스트림
값이 남아 있으면 3개의 Worker가 올바르게 배포되지 않습니다**. 11개의 Durable Object binding,
Analytics Engine 데이터셋, `send_email` binding, 2개의 cron trigger는 Core에만 속하며 이미 선언되어
있습니다.

secret을 설정하고 로컬에서 검증한 다음 Workers Builds를 연결하십시오. 3개의 production build가
성공한 후 초기화하십시오. `KEK`을 분실하면 모든 서명 키와 저장된 provider 자격 증명을 복호화할
수 없게 되고, `PEPPER`를 분실하면 모든 비밀번호 해시가 무효가 됩니다. 두 값 모두 Cloudflare
외부에 먼저 백업하십시오.

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

`xid`, `xid-console`, `xid-site`를 이 Git repository에 연결된 3개의 Cloudflare Workers Builds
project로 구성하십시오. Production branch는 `main`으로 설정하고 non-production branch build와
Worker Preview URLs는 비활성화하며, [`docs/deployment.md`](docs/deployment.md)의 root, build,
deploy command를 사용하십시오. review와 서명을 마친 commit을 `main`에 merge하면 Workers Builds가
remote D1 migration을 적용하고 3개의 Worker를 배포합니다. 모든 build가 성공한 후:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

bootstrap은 인스턴스, 기본 조직, 인스턴스 ES256 서명 키, 그리고 최초 `instance_manager` 사용자를
생성하며 두 번 실행되지 않습니다. 로컬 D1 마이그레이션, 시딩, 3 Worker 릴리스 순서와 롤백을 포함한
전체 절차는 [`docs/deployment.md`](docs/deployment.md)에 있습니다. 셀프 호스팅 릴리스에는 Core,
Console, Site를 모두 배포해야 합니다. Site는 apex, 8 locale 문서, SEO, Pagefind, agent surfaces,
`www` 308을 담당하고 Console은 `/console`과 `/console/*`를 담당합니다.

### 개발

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check`는 두 번의 커버리지 실행을 포함한 전체 게이트이며 가벼운 lint가 아닙니다. 이
명령은 `native:verify`를 호출하는데, `XID_NATIVE_SDK_PLATFORM`을 설정하지 않으면 네이티브 SDK 계약
매트릭스만 검증하므로 네이티브 툴체인이 필요하지 않습니다. GitHub Actions는 검증만 하고 배포는 하지
않습니다. 프로덕션 배포는 저장소 소유자 계정의 Cloudflare Workers Builds에서 실행됩니다. 영역별
작업 절차는 [`CONTRIBUTING.md`](CONTRIBUTING.md)를 참고하십시오.

## 아키텍처

3개의 Worker가 하나의 hostname을 공유하지만 runtime binding은 공유하지 않습니다. Nimbus Site는 apex
documentation hub, 8 locale 문서 트리, SEO, Pagefind, Markdown 및 MDX twins, LLM indexes, `www`에서 apex로의
308을 담당합니다. Console은 binding이 없는 정적 Worker이며 apex와 tenant host의 `/console` 및
`/console/*`를 담당합니다. Core는 Hosted Auth, 계정 페이지, 프로토콜과 API route, `/_core/*`를
담당하며 D1, Durable Objects, KV, R2, Queues, email, Analytics Engine, cron binding을 보유하는 유일한
Worker입니다.

Core 상태는 일관성 요구 사항에 따라 분리됩니다. 관계형 데이터는 D1, 직렬화가 필요한 모든 것
(WebAuthn challenge, OAuth state, PAR, device flow, 세션 폐기, rate limit, 감사 시퀀스, 미터링)은
Durable Objects, 캐시 읽기는 KV, blob은 R2, 로그인 경로에서 반드시 분리해야 하는 작업은 Queues가
담당합니다.

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

public runtime kernel은 `protocol`, `crypto`, `types`입니다. private implementation 패키지는
`webauthn`, `saml`, `db`, `i18n`, `web-ui`입니다. 암호학 프리미티브는 항상 Web Crypto에서 가져오고
XML-DSig는 `xmldsigjs`에 위임하며, 그 사이의 프로토콜과 비즈니스 로직은 이 저장소에서 직접 작성합니다.

## 프로토콜 지원

모든 행은 [`docs/protocols/source-map.md`](docs/protocols/source-map.md)의 파일 및 테스트와
대응됩니다.

| 영역                                                                   | 지원   | 최고 근거 등급                | 비고                                                                 |
| ---------------------------------------------------------------------- | ------ | ----------------------------- | -------------------------------------------------------------------- |
| OAuth 2.x 코어 (code, PKCE S256, client credentials, refresh rotation) | 구현됨 | 로컬 프로토콜 클라이언트      | implicit 및 password grant는 거부되며 negative 테스트로 검증         |
| OIDC 코어 (ID token, userinfo, logout, session management, hybrid)     | 구현됨 | 로컬 프로토콜 클라이언트      | front-channel 및 back-channel logout profile 포함                    |
| PAR, DPoP, Device Flow                                                 | 구현됨 | 로컬 프로토콜 클라이언트      | DPoP nonce challenge는 미구현                                        |
| Browser-Based Apps 및 FAPI 2.0 enforcement profile                     | 구현됨 | Workers 런타임 통합 테스트    | 로컬 policy 근거만 존재하며 프로덕션 conformance는 주장하지 않음     |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA                        | 구현됨 | Workers 런타임 통합 테스트    | JWE, 원격 request-object fetch, `form_post.jwt`는 지원하지 않음      |
| OpenID Federation                                                      | 구현됨 | Workers 런타임 통합 테스트    | 최소 metadata 및 registration boundary만 제공하며 trust chain은 없음 |
| SAML 2.0 SP (인바운드) 및 IdP (아웃바운드)                             | 구현됨 | 로컬 가짜 IdP 및 가짜 SaaS SP | Okta, Entra ID, Google Workspace 대상 검증 미실시                    |
| SCIM 2.0 Service Provider 및 아웃바운드 프로비저닝                     | 구현됨 | 로컬 가짜 SaaS SCIM           | 실제 디렉터리 또는 SaaS 대상 검증 미실시                             |
| WebAuthn, passkey, passkey MFA, AAL2 step-up                           | 구현됨 | Workers 런타임 통합 테스트    | 로컬 EdDSA와 packed attestation 포함, AAL3는 미지원                  |
| LDAP direct bind, WS-Federation, SWA, 헤더 기반 SSO                    | 구현됨 | 로컬 하네스                   | Kerberos는 문서만 존재                                               |
| 소셜 OAuth Relying Party (Google, GitHub, Microsoft, Apple)            | 구현됨 | 로컬 가짜 provider            | 실제 provider secret 및 콜백 검증 미실시                             |
| Shared Signals, CAEP, RISC                                             | 계획됨 | negative route 테스트         | 엔드포인트가 501을 반환하며 스트림을 생성하지 않음                   |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | 계획됨 | negative route 테스트         | 예약 라우트가 501을 반환하며 프로토콜 구현이 아님                    |

## SDK

`packages/` 아래에는 TypeScript SDK 패키지 15개가 있습니다. `core`와 `backend`, 그리고 React,
Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron, Tauri용
framework binding입니다. public runtime kernel 3개(`crypto`, `protocol`, `types`)를 합친 18개
패키지가 publishable로 설정되어 있고 깨끗한 로컬 tarball installation test를 통과합니다. 나머지
5개(`db`, `i18n`, `saml`, `web-ui`, `webauthn`)는 private implementation 패키지입니다. 외부 npm
registry 배포 상태는 여전히 `UNKNOWN`이며, 로컬 distribution evidence는 registry release를
입증하지 않습니다.

`sdk/` 아래의 네이티브 SDK 13개: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS,
Linux, Android, Flutter. **crates.io, PyPI, Maven Central, RubyGems, Packagist, NuGet, CocoaPods,
pub.dev 어디에도 배포되지 않았으며** 릴리스 파이프라인도 존재하지 않습니다. 소스에서 직접
가져다 사용하는 방식입니다. CI는 어떤 언어 툴체인도 설치하지 않으며 이들의 테스트 스위트도 실행하지
않습니다. CI가 검증하는 것은 `tests/native-sdk-contract.test.mjs`의 계약 매트릭스입니다. `pnpm check`가
`check` job 안에서 `native:verify`를 호출해, 매트릭스의 모든 플랫폼 항목이 실제로 존재하는 디렉터리를
가리키는지 단언합니다. 특정 플랫폼의 실제 툴체인을 실행하는 것은 로컬 opt-in 작업이며
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`를 사용합니다. 플랫폼별 성숙도는
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md)에 있습니다.

## 문서

독자별로 경로를 안내하는 [`docs/README.md`](docs/README.md)에서 시작하십시오. `docs/` 아래 문서는
모두 영어로 작성되어 있으며 영어판이 정본입니다. [`docs/zh-Hans/`](docs/zh-Hans/README.md)에 간체
중국어 미러가 있지만 진입 문서와 설계 장에만 한정됩니다. **한국어 문서 번역은 없습니다.**

- 제품 설계, 9개 장: [`docs/design/`](docs/design/README.md)
- 프로토콜 매트릭스 및 갭 감사: [`docs/protocols/`](docs/protocols/README.md)
- HTTP 엔드포인트 계약: [`docs/api-contracts.md`](docs/api-contracts.md)
- 셀프 호스팅: [`docs/deployment.md`](docs/deployment.md)
- 표준 원문 URL: [`docs/standards-sources.md`](docs/standards-sources.md)

## 기여, 보안, 라이선스

pull request를 열기 전에 [`CONTRIBUTING.md`](CONTRIBUTING.md)를 읽으십시오. 툴체인, 필수 게이트,
Developer Certificate of Origin 서명 절차를 다룹니다. 참여는
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)의 적용을 받으며, 코드 변경이 아닌 질문은
[`SUPPORT.md`](SUPPORT.md)에서 다룹니다. 취약점은 공개 이슈로 등록하지 마십시오. 신고 채널, 범위,
공개 일정은 [`SECURITY.md`](SECURITY.md)에 있습니다.

XID는 MIT License로 배포됩니다. [`LICENSE`](LICENSE)를 참고하십시오. 저작권 고지와 라이선스 전문을
유지하는 한, 상업적 용도와 비공개 소스 제품을 포함하여 자유롭게 사용, 수정, 배포할 수 있습니다.

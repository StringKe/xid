# XID

[English](README.md) | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | 한국어 | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

하나의 코드베이스에서 3개의 Cloudflare Workers로 배포하는 엣지 네이티브 아이덴티티 플랫폼입니다.
Core Worker는 OIDC/OAuth, 멀티 테넌트 RBAC, 엔터프라이즈 SSO 페더레이션, Hosted Auth, 계정 페이지를
제공합니다. Nimbus Site Worker는 apex 루트의 완전한 다국어 문서를, 분리된 Console Worker는 관리 UI를
제공합니다.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

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

**프로토콜 표면**

- OIDC 및 OAuth 2.x authorization server: discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, 동적 클라이언트
  등록(RFC 7591/7592), CIBA 백채널 인증.
- PKCE S256을 강제하는 authorization code, client credentials, device code, family 재사용 감지 시
  일괄 폐기하는 refresh rotation, RFC 8693 token exchange. DPoP 및 mTLS 기반 sender-constrained
  token, 서명된 request object(JAR)와 서명된 authorization response(JARM).
- 양방향 엔터프라이즈 SSO: 인바운드 SAML 2.0 SP 및 OIDC RP 페더레이션, 하위 SaaS를 위한 아웃바운드
  SAML 2.0 IdP, 그리고 LDAP direct bind, WS-Federation, SWA 패스워드 볼팅, 헤더 기반 SSO.
- SCIM 2.0 Service Provider(Users, Groups, PATCH, filter, sort, bulk, ETag/If-Match)와 하위 SaaS
  대상으로의 아웃바운드 프로비저닝.

**인증**

- 주 자격 증명으로서의 passkey/WebAuthn: discoverable credential, user verification 강제,
  sign-count 복제 감지.
- Workers Secrets에 보관하는 서버 측 pepper와 함께 Argon2id로 해싱한 비밀번호, magic link,
  이메일/SMS/WhatsApp 일회용 코드, Relying Party로서의 소셜 OAuth.
- TOTP, SMS, 두 번째 인증 요소로서의 passkey, 일회용 백업 코드를 지원하는 MFA.

**플랫폼**

- 조직, 멤버십, 역할, 권한, 초대, 도메인 검증.
- `/v1/*` 아래의 Management API, `/v1/me/*` 아래의 셀프 서비스 계정 포털, `/v1/platform/*` 아래의
  인스턴스 운영자 API.
- SHA-256 체인 해시를 사용하는 append-only 감사 로그, dead-letter queue를 갖춘 서명 webhook,
  feature flag, 사용량 미터링.
- 8개 로케일(en, zh-Hans, ja, ko, fr, de, es, pt-BR)로 제공되며 카탈로그가 모두 번역된 Hosted UI.

## 빠른 시작

### 애플리케이션 연동

`@xid-kit/*` 패키지는 **npm에 배포되지 않습니다**. workspace 패키지이므로 현재 자신의 애플리케이션에서
사용하려면 소스를 벤더링하거나 이 저장소를 workspace에 추가해야 합니다. 아래 API가 현재의 공개
표면입니다. `@xid-kit/react`에서:

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
for q in xid-email xid-whatsapp xid-sms xid-audit xid-webhook xid-metering xid-dlq; do
  npx wrangler queues create "$q"
done
```

그다음 `apps/server/wrangler.jsonc`, `apps/console/wrangler.jsonc`,
`apps/site/wrangler.jsonc`의 업스트림 account와 route 값을 자신의 값으로 교체하고,
`apps/site/astro.config.ts`의 canonical public origin을 자신의 HTTPS apex URL로 설정하십시오. Core
설정에는 D1 `database_id`와 KV namespace `id`도 필요합니다. 셀프 호스팅 템플릿은 없으며, **업스트림
값이 남아 있으면 3개의 Worker가 올바르게 배포되지 않습니다**. 8개의 Durable Object binding,
Analytics Engine 데이터셋, `send_email` binding, 2개의 cron trigger는 Core에만 속하며 이미 선언되어
있습니다.

secret을 설정하고, 마이그레이션하고, 배포한 뒤 초기화하십시오. `KEK`을 분실하면 모든 서명 키와
저장된 provider 자격 증명을 복호화할 수 없게 되고, `PEPPER`를 분실하면 모든 비밀번호 해시가
무효가 됩니다. 두 값 모두 Cloudflare 외부에 먼저 백업하십시오.

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

npx wrangler d1 migrations apply DB --remote
cd ../..
pnpm run build
pnpm exec wrangler deploy --config apps/server/wrangler.jsonc
pnpm exec wrangler deploy --config apps/console/wrangler.jsonc
pnpm exec wrangler deploy --config apps/site/wrangler.jsonc

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
packages/          22 workspace packages: 7 kernel libraries + 15 TypeScript SDKs
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

커널 라이브러리인 `protocol`, `crypto`, `webauthn`, `saml`, `db`, `i18n`, `types`는 Core Worker 내부
전용입니다. 암호학 프리미티브는 항상 Web Crypto에서 가져오고 XML-DSig는 `xmldsigjs`에 위임하며,
그 사이의 프로토콜과 비즈니스 로직은 이 저장소에서 직접 작성합니다.

## 프로토콜 지원

모든 행은 [`docs/protocols/source-map.md`](docs/protocols/source-map.md)의 파일 및 테스트와
대응됩니다.

| 영역                                                                   | 지원   | 최고 근거 등급                | 비고                                                                      |
| ---------------------------------------------------------------------- | ------ | ----------------------------- | ------------------------------------------------------------------------- |
| OAuth 2.x 코어 (code, PKCE S256, client credentials, refresh rotation) | 구현됨 | 로컬 프로토콜 클라이언트      | implicit 및 password grant는 거부되며 negative 테스트로 검증              |
| OIDC 코어 (ID token, userinfo, logout, session management, hybrid)     | 구현됨 | 로컬 프로토콜 클라이언트      | front-channel 및 back-channel logout 프로파일 포함                        |
| PAR, DPoP, device flow                                                 | 구현됨 | 로컬 프로토콜 클라이언트      | DPoP nonce challenge는 미구현                                             |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA, OpenID Federation     | 구현됨 | Workers 런타임 통합 테스트    | JWE, 원격 request object 조회, `form_post.jwt`는 지원 주장하지 않음       |
| SAML 2.0 SP (인바운드) 및 IdP (아웃바운드)                             | 구현됨 | 로컬 가짜 IdP 및 가짜 SaaS SP | Okta, Entra ID, Google Workspace 대상 검증 미실시                         |
| SCIM 2.0 Service Provider 및 아웃바운드 프로비저닝                     | 구현됨 | 로컬 가짜 SaaS SCIM           | 실제 디렉터리 또는 SaaS 대상 검증 미실시                                  |
| WebAuthn / passkey                                                     | 구현됨 | Workers 런타임 통합 테스트    | 우회 경로 없는 4단계 검증                                                 |
| LDAP direct bind, WS-Federation, SWA, 헤더 기반 SSO                    | 구현됨 | 로컬 하네스                   | Kerberos는 문서만 존재                                                    |
| 소셜 OAuth Relying Party (Google, GitHub, Microsoft, Apple)            | 구현됨 | 로컬 가짜 provider            | 실제 provider secret 및 콜백 검증 미실시                                  |
| Shared Signals, CAEP, RISC                                             | 계획됨 | 유닛 테스트                   | 엔드포인트가 501을 반환하며 스트림을 생성하지 않음                        |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | 스텁   | Workers 런타임 통합 테스트    | 501 또는 placeholder 객체를 반환하는 라우트 스텁이며 프로토콜 구현이 아님 |

## SDK

`packages/` 아래의 TypeScript 패키지 15개: `core`와 `backend`, 그리고 React, Next.js, Remix,
Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron, Tauri용 프레임워크 바인딩.
모두 workspace 전용이며 **npm에 배포되지 않습니다**.

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

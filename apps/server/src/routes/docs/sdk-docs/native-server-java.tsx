// sdk/java 参考页。API 真相源:sdk/java/README.md + sdk/java/src/main/java/dev/xid/sdk/。
// 状态:Implemented · verified locally -- real IdP round-trip 验证待人工完成。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Implemented and verified locally. Real IdP round-trip verification (JWKS fetch, token
        sign/verify against a live XID instance) has not been performed yet and must be completed
        before production use.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Install</Trans>,
    body: [<Trans>Java 17+ and Maven required.</Trans>],
    code: `<dependency>
  <groupId>dev.xid</groupId>
  <artifactId>xid-sdk-java</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    body: [
      <Trans>
        Construct one <code>XidClient</code> at application startup and use it as a singleton.
      </Trans>,
    ],
    code: `import dev.xid.sdk.XidClient;
import dev.xid.sdk.XidClientOptions;
import dev.xid.sdk.XidClaims;
import dev.xid.sdk.XidTokenException;
import dev.xid.sdk.XidJwksException;

XidClient xid = XidClient.create(
    XidClientOptions.builder()
        .issuer("https://xid.dev")
        .audience("your-client-id")
        .webhookSecret("whsec_xxx")
        .build()
);

try {
    XidClaims claims = xid.verifyToken(accessToken);
    String userId = claims.getSub();
    String scope  = claims.getScope();
} catch (XidTokenException e) {
    response.sendError(401, "Unauthorized: " + e.getReason());
} catch (XidJwksException e) {
    response.sendError(503, "Service unavailable");
}`,
  },
  {
    heading: <Trans>Authenticate an HTTP request</Trans>,
    code: `import dev.xid.sdk.AuthResult;

// Option A: pass Authorization header value directly
AuthResult result = xid.authenticateRequest(authHeader, null);

// Option B: pass a headers Map (Spring MVC example)
Map<String, String> headers = Collections.list(request.getHeaderNames())
    .stream()
    .collect(Collectors.toMap(h -> h, request::getHeader));
AuthResult result = xid.authenticateRequest(headers);

if (result.isAuthenticated()) {
    String userId = result.getClaims().get().getSub();
} else {
    response.sendError(401);
}`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `import dev.xid.sdk.XidWebhookException;

byte[] rawBody = request.getInputStream().readAllBytes();
Map<String, String> headers = Map.of(
    "svix-id",        request.getHeader("svix-id"),
    "svix-timestamp", request.getHeader("svix-timestamp"),
    "svix-signature", request.getHeader("svix-signature")
);

try {
    xid.verifyWebhook(headers, rawBody);
} catch (XidWebhookException e) {
    response.sendError(400, "Invalid webhook: " + e.getReason());
}`,
  },
  {
    heading: <Trans>XidClientOptions</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">.issuer(String)</code>,
          <Trans>required</Trans>,
          <Trans>OIDC issuer; must match token iss exactly</Trans>,
        ],
        [
          <code key="m">.audience(String)</code>,
          <code key="v">null</code>,
          <Trans>Expected aud; null skips validation</Trans>,
        ],
        [
          <code key="m">.webhookSecret(String)</code>,
          <code key="v">null</code>,
          <Trans>
            Webhook secret (<code>whsec_</code> prefix or raw base64)
          </Trans>,
        ],
        [
          <code key="m">.jwksCacheDuration(Duration)</code>,
          <Trans>1 hour</Trans>,
          <Trans>JWKS in-memory cache TTL</Trans>,
        ],
        [
          <code key="m">.clockSkewTolerance(Duration)</code>,
          <Trans>30 seconds</Trans>,
          <Trans>exp/nbf clock skew tolerance</Trans>,
        ],
        [
          <code key="m">.connectTimeout(Duration)</code>,
          <Trans>5 seconds</Trans>,
          <Trans>HTTP connection timeout for JWKS fetch</Trans>,
        ],
        [
          <code key="m">.readTimeout(Duration)</code>,
          <Trans>10 seconds</Trans>,
          <Trans>HTTP read timeout for JWKS fetch</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Uses <code>nimbus-jose-jwt</code> for JWT/JWKS parsing. ES256 is primary; RS256 and PS256
        are supported.
      </Trans>,
      <Trans>All public APIs are synchronous and thread-safe.</Trans>,
      <Trans>Logging via SLF4J facade; bring your own implementation (Logback, Log4j2).</Trans>,
      <Trans>
        Exception hierarchy: <code>XidException</code> -{'>'} <code>XidTokenException</code>,{' '}
        <code>XidJwksException</code>, <code>XidWebhookException</code>.
      </Trans>,
    ],
  },
]

export const JAVA_DOC = defineSdkDoc({
  slug: 'sdks/java',
  packageName: 'sdk/java',
  summary: (
    <Trans>
      Java 17+ server SDK for networkless JWT verification, HTTP request authentication, and webhook
      signature validation.
    </Trans>
  ),
  sections,
})

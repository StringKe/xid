// sdk/dotnet 参考页。API 真相源:sdk/dotnet/README.md + sdk/dotnet/src/。
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
    body: [<Trans>.NET 8 target required.</Trans>],
    code: `<PackageReference Include="Xid" Version="0.1.0" />`,
  },
  {
    heading: <Trans>ASP.NET Core setup (recommended)</Trans>,
    code: `// Program.cs
using Xid;

builder.Services.AddXid(options =>
{
    options.Issuer   = "https://xid.dev";
    options.Audience = "your-client-id"; // optional
});`,
  },
  {
    heading: <Trans>Authenticate a request</Trans>,
    code: `// Controller / Minimal API
public class MyController(XidClient xid) : ControllerBase
{
    [HttpGet("/me")]
    public async Task<IActionResult> GetMe()
    {
        var auth = await xid.AuthenticateRequestAsync(
            authorizationHeader: Request.Headers.Authorization,
            cookies: Request.Cookies.ToDictionary(c => c.Key, c => c.Value));

        if (!auth.Authenticated)
            return Unauthorized(auth.Reason);

        return Ok(new { sub = auth.Claims!.Sub, email = auth.Claims.Email });
    }
}`,
  },
  {
    heading: <Trans>Verify token directly</Trans>,
    code: `using Xid;

var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" });

try
{
    var claims = await client.VerifyTokenAsync("eyJ...");
    Console.WriteLine($"sub={claims.Sub} email={claims.Email}");
}
catch (TokenVerificationException ex)
{
    Console.WriteLine($"Invalid token: {ex.Message}");
}`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `app.MapPost("/webhooks/xid", async (HttpRequest req, XidClient xid) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var body = ms.ToArray();

    var headers = new Dictionary<string, string>
    {
        ["svix-id"]        = req.Headers["svix-id"].ToString(),
        ["svix-timestamp"] = req.Headers["svix-timestamp"].ToString(),
        ["svix-signature"] = req.Headers["svix-signature"].ToString(),
    };

    try
    {
        var webhook = xid.VerifyWebhook(body, headers, secret: "whsec_your_secret");
        return Results.Ok();
    }
    catch (WebhookVerificationException ex)
    {
        return Results.BadRequest(ex.Message);
    }
});`,
  },
  {
    heading: <Trans>XidOptions</Trans>,
    table: {
      headers: [<Trans>Property</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [<code key="p">Issuer</code>, <Trans>required</Trans>, <Trans>XID issuer URL</Trans>],
        [
          <code key="p">Audience</code>,
          <code key="v">null</code>,
          <Trans>Expected aud claim; null skips validation</Trans>,
        ],
        [
          <code key="p">JwksTtl</code>,
          <Trans>1 hour</Trans>,
          <Trans>JWKS in-memory cache TTL</Trans>,
        ],
        [
          <code key="p">SessionCookieName</code>,
          <code key="v">__session</code>,
          <Trans>Fallback cookie name for token extraction</Trans>,
        ],
        [
          <code key="p">ClockSkew</code>,
          <Trans>5 minutes</Trans>,
          <Trans>JWT exp/nbf clock skew tolerance</Trans>,
        ],
        [
          <code key="p">WebhookToleranceWindow</code>,
          <Trans>5 minutes</Trans>,
          <Trans>Webhook replay prevention window</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>XidClient API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">VerifyTokenAsync(token, ct)</code>,
          <Trans>
            Verify JWT string; throws <code>TokenVerificationException</code> on failure.
          </Trans>,
        ],
        [
          <code key="m">AuthenticateRequestAsync(authHeader, cookies, ct)</code>,
          <Trans>
            Extract and verify token; returns <code>AuthStatus</code>; does not throw.
          </Trans>,
        ],
        [
          <code key="m">VerifyWebhook(payload, headers, secret)</code>,
          <Trans>
            Validate webhook signature; throws <code>WebhookVerificationException</code> on failure.
            Synchronous.
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Uses <code>Microsoft.IdentityModel.Tokens</code> and{' '}
        <code>System.IdentityModel.Tokens.Jwt</code> 8.x. ES256 is primary; RS256 and PS256 are
        supported.
      </Trans>,
      <Trans>
        <code>AddXid()</code> registers <code>XidClient</code> as a singleton and wires{' '}
        <code>IHttpClientFactory</code> for JWKS fetching.
      </Trans>,
      <Trans>
        Exception hierarchy: <code>XidException</code> -{'>'} <code>JwksException</code>,{' '}
        <code>TokenVerificationException</code>, <code>WebhookVerificationException</code>.
      </Trans>,
    ],
  },
]

export const DOTNET_DOC = defineSdkDoc({
  slug: 'sdks/dotnet',
  packageName: 'sdk/dotnet',
  summary: (
    <Trans>
      .NET 8 server SDK for networkless JWT verification, ASP.NET Core request authentication, and
      webhook signature validation.
    </Trans>
  ),
  sections,
})

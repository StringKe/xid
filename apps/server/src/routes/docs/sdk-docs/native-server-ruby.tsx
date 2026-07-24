// sdk/ruby 参考页。API 真相源:sdk/ruby/README.md + sdk/ruby/lib/。
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
    code: `# Gemfile
gem "xid"

bundle install`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `require "xid"

Xid.configure do |c|
  c.issuer         = "https://xid.dev"
  c.audience       = "your_client_id"
  c.webhook_secret = "whsec_AbCdEf..."
end

# Verify a token
begin
  claims = Xid.verify_token(raw_token)
  puts claims.sub    # => "usr_abc123"
  puts claims.scope  # => "openid profile email"
rescue Xid::TokenVerificationError => e
  puts "Token invalid: #{e.message}"
end`,
  },
  {
    heading: <Trans>Authenticate a Rack/Rails request</Trans>,
    code: `# Sinatra before-filter
before do
  auth = Xid.authenticate_request(request)
  halt 401, "Unauthorized" unless auth.signed_in?
  @current_user_id = auth.claims.sub
end

# Rack middleware (env-based)
auth = Xid.authenticate_request(env)
unless auth.signed_in?
  return [401, { "Content-Type" => "application/json" },
          [JSON.generate({ error: auth.reason })]]
end`,
  },
  {
    heading: <Trans>Verify webhook</Trans>,
    code: `# Rails controller action
def receive
  raw_body = request.raw_post
  payload = Xid.verify_webhook(request.headers.to_h, raw_body)
  handle_event(payload["type"], payload["data"])
  head :ok
rescue Xid::WebhookVerificationError
  head :bad_request
end`,
  },
  {
    heading: <Trans>Multi-issuer setup</Trans>,
    code: `config_a = Xid::Configuration.new
config_a.issuer   = "https://tenant-a.xid.dev"
config_a.audience = "client_a"
client_a = Xid::Client.new(config_a)
claims = client_a.verify_token(token)`,
  },
  {
    heading: <Trans>Configuration options</Trans>,
    table: {
      headers: [<Trans>Key</Trans>, <Trans>Default</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="k">issuer</code>,
          <code key="v">https://xid.dev</code>,
          <Trans>OIDC issuer URL</Trans>,
        ],
        [
          <code key="k">audience</code>,
          <code key="v">nil</code>,
          <Trans>Expected aud claim; nil skips validation</Trans>,
        ],
        [
          <code key="k">jwks_ttl</code>,
          <code key="v">3600</code>,
          <Trans>JWKS local cache TTL in seconds</Trans>,
        ],
        [
          <code key="k">leeway</code>,
          <code key="v">60</code>,
          <Trans>JWT clock skew tolerance in seconds</Trans>,
        ],
        [
          <code key="k">webhook_secret</code>,
          <code key="v">nil</code>,
          <Trans>
            Webhook signing secret with <code>whsec_</code> prefix
          </Trans>,
        ],
        [
          <code key="k">webhook_tolerance</code>,
          <code key="v">300</code>,
          <Trans>Webhook replay window in seconds</Trans>,
        ],
        [
          <code key="k">cookie_name</code>,
          <code key="v">__xid_token</code>,
          <Trans>Cookie key for access token extraction</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Platform notes</Trans>,
    bullets: [
      <Trans>
        Depends on the <code>jwt</code> gem (ES256/RS256 support). Ruby 3.1+ required.
      </Trans>,
      <Trans>
        <code>Xid.authenticate_request</code> accepts both a Rack env hash and a Rack{' '}
        <code>Request</code> object.
      </Trans>,
      <Trans>
        Exception hierarchy: <code>Xid::Error</code> -{'>'} <code>ConfigurationError</code>,{' '}
        <code>JwksError</code>, <code>TokenVerificationError</code>,{' '}
        <code>WebhookVerificationError</code>.
      </Trans>,
    ],
  },
]

export const RUBY_DOC = defineSdkDoc({
  slug: 'sdks/ruby',
  packageName: 'sdk/ruby',
  summary: (
    <Trans>
      Ruby server SDK for networkless JWT verification, Rack/Rails request authentication, and
      webhook signature validation.
    </Trans>
  ),
  sections,
})

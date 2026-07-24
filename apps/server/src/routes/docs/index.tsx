import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { BrandLogo } from '../../components/BrandLogo'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { PublicAuthLink } from '../../components/PublicAuthLink'
import { Link, useLocation } from '../../lib/router'
import { tokens } from '../../styles/tokens.stylex'
import { getPublicDocsRouteDecision, normalizeDocsPath, resolvePublicDocSlug } from './registry'
import { SDK_DETAIL_DOCS } from './sdk-docs'

type DocTable = {
  headers: readonly ReactNode[]
  rows: readonly (readonly ReactNode[])[]
}

type DocSection = {
  heading: ReactNode
  body?: readonly ReactNode[]
  bullets?: readonly ReactNode[]
  code?: string
  table?: DocTable
}

type DocEntry = {
  slug: string
  title: ReactNode
  // SDK 详情页携带纯字符串包标识(dev 路由诊断用),顶层文档页无此字段。
  titleLabel?: string
  href: string
  summary: ReactNode
  sections: readonly DocSection[]
}

// 代码形态字面量以 ICU 参数注入 Trans,{svix-id} 直接内联会被当 ICU 参数且连字符非法(compile 静默丢弃该条)
const SVIX_SIGNATURE_INPUT = '${svix-id}.${svix-timestamp}.${raw-body}'

const DOCS: readonly DocEntry[] = [
  {
    slug: 'getting-started',
    title: <Trans>Getting started</Trans>,
    href: '/docs/getting-started',
    summary: <Trans>Connect an application to XID with OIDC discovery and Hosted Auth.</Trans>,
    sections: [
      {
        heading: <Trans>Base URLs</Trans>,
        body: [
          <Trans>
            XID is an identity provider. The instance domain is the OIDC issuer, API base URL,
            Hosted Auth base URL, and console base URL. Organizations provide policy, branding,
            membership, and resource isolation.
          </Trans>,
          <Trans>
            Start by reading <code>/.well-known/openid-configuration</code> from the instance
            domain. The discovery document gives your app the authorization, token, userinfo,
            logout, and JWKS endpoints for that issuer.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Surface</Trans>, <Trans>Path</Trans>, <Trans>Use</Trans>],
          rows: [
            [
              <Trans>OIDC discovery</Trans>,
              <code key="path">/.well-known/openid-configuration</code>,
              <Trans>Read issuer metadata before configuring a relying party.</Trans>,
            ],
            [
              <Trans>Authorization</Trans>,
              <code key="path">/authorize</code>,
              <Trans>Redirect users to the unified Hosted Auth flow.</Trans>,
            ],
            [
              <Trans>Token</Trans>,
              <code key="path">/token</code>,
              <Trans>Exchange an authorization code or refresh token.</Trans>,
            ],
            [
              <Trans>Userinfo</Trans>,
              <code key="path">/userinfo</code>,
              <Trans>Read claims for a valid access token.</Trans>,
            ],
            [
              <Trans>Management API</Trans>,
              <code key="path">/v1/*</code>,
              <Trans>Manage organization resources from your backend.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Minimum integration</Trans>,
        bullets: [
          <Trans>Create an OIDC application and register exact redirect URI values.</Trans>,
          <Trans>Use authorization code flow with PKCE S256 for browser and native clients.</Trans>,
          <Trans>Validate ID tokens and access tokens against the issuer and JWKS URI.</Trans>,
          <Trans>Store refresh tokens server side or in a secure native credential store.</Trans>,
        ],
      },
      {
        heading: <Trans>Authorization request</Trans>,
        code: `const authorizeUrl = new URL('https://xid.dev/authorize')
authorizeUrl.searchParams.set('client_id', clientId)
authorizeUrl.searchParams.set('redirect_uri', redirectUri)
authorizeUrl.searchParams.set('response_type', 'code')
authorizeUrl.searchParams.set('scope', 'openid profile email')
authorizeUrl.searchParams.set('code_challenge', codeChallenge)
authorizeUrl.searchParams.set('code_challenge_method', 'S256')`,
      },
    ],
  },
  {
    slug: 'hosted-auth',
    title: <Trans>Hosted Auth</Trans>,
    href: '/docs/hosted-auth',
    summary: <Trans>Configure the unified sign-in and user creation flow.</Trans>,
    sections: [
      {
        heading: <Trans>Unified flow</Trans>,
        body: [
          <Trans>
            XID does not expose separate end-user registration and login products. Hosted Auth
            starts from the same identifier step and decides login or user creation from
            organization policy and account state.
          </Trans>,
          <Trans>
            Bootstrap defaults enable email magic link and email OTP only. Password, WhatsApp OTP,
            SMS OTP, passkey, social OAuth, and enterprise SSO stay hidden until the organization
            policy and required credentials enable them.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Configuration endpoint</Trans>,
        body: [
          <Trans>
            <code>GET /auth/config</code> returns the public Hosted Auth configuration for the
            organization. Provider secrets and disabled providers are not returned to the browser.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Method</Trans>, <Trans>Displayed when</Trans>],
          rows: [
            [
              <Trans>Magic link</Trans>,
              <Trans>Enabled and allowed for login or user creation.</Trans>,
            ],
            [
              <Trans>Email OTP</Trans>,
              <Trans>Enabled and allowed for login or user creation.</Trans>,
            ],
            [
              <Trans>Phone OTP</Trans>,
              <Trans>
                WhatsApp or SMS provider is configured, enabled, and allowed for login or user
                creation.
              </Trans>,
            ],
            [
              <Trans>Password</Trans>,
              <Trans>Password policy enables login or user creation.</Trans>,
            ],
            [
              <Trans>Social OAuth</Trans>,
              <Trans>Provider is enabled, credentials exist, and policy allows the action.</Trans>,
            ],
            [
              <Trans>Inbound enterprise SSO</Trans>,
              <Trans>Domain discovery matches a verified organization domain.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Identifier policy</Trans>,
        bullets: [
          <Trans>
            Organizations can require email identifiers, username identifiers, or both.
          </Trans>,
          <Trans>Allowed and blocked email domain lists apply before user creation.</Trans>,
          <Trans>Force SSO hides local methods when an enterprise connection is required.</Trans>,
        ],
      },
      {
        heading: <Trans>WebAuthn and passkey boundaries</Trans>,
        bullets: [
          <Trans>
            Passkey sign-in is primary AAL2 authentication. Password or OTP sessions can complete
            MFA through <code>/auth/mfa/passkey/*</code> with user verification required.
          </Trans>,
          <Trans>
            Organization policy <code>attestationMode</code> selects none, indirect, or direct
            enterprise attestation during passkey registration.
          </Trans>,
          <Trans>
            WebAuthn credential parameters advertise ES256, RS256, and EdDSA. Syncable passkeys
            remain AAL2 even after MFA.
          </Trans>,
          <Trans>
            <code>urn:xid:aal3</code> is issued only when passkey MFA meets hardware single-device,
            non-backed-up assurance. Syncable passkeys do not qualify for AAL3.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'oidc-oauth',
    title: <Trans>OIDC and OAuth</Trans>,
    href: '/docs/oidc-oauth',
    summary: <Trans>Discovery, authorization, token, logout, and OAuth extension endpoints.</Trans>,
    sections: [
      {
        heading: <Trans>Core endpoints</Trans>,
        table: {
          headers: [<Trans>Endpoint</Trans>, <Trans>Description</Trans>],
          rows: [
            [
              <code key="path">/.well-known/openid-configuration</code>,
              <Trans>OIDC discovery for the current issuer.</Trans>,
            ],
            [
              <code key="path">/.well-known/oauth-protected-resource</code>,
              <Trans>OAuth protected resource metadata for XID-hosted resource endpoints.</Trans>,
            ],
            [
              <code key="path">/jwks</code>,
              <Trans>Instance public signing keys with active and rotating kids.</Trans>,
            ],
            [
              <code key="path">/authorize</code>,
              <Trans>
                Authorization endpoint with PKCE, state, nonce, PAR, and Hosted Auth handoff.
              </Trans>,
            ],
            [
              <code key="path">/par</code>,
              <Trans>Pushed Authorization Requests with one-time request_uri values.</Trans>,
            ],
            [
              <code key="path">/token</code>,
              <Trans>
                Authorization code, refresh token, client credentials, device code, and token
                exchange.
              </Trans>,
            ],
            [
              <code key="path">/userinfo</code>,
              <Trans>Bearer or DPoP access token user claims.</Trans>,
            ],
            [
              <code key="path">/end_session</code>,
              <Trans>RP-initiated logout with registered post logout redirects.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Protocol requirements</Trans>,
        bullets: [
          <Trans>PKCE uses S256. Plain PKCE is rejected.</Trans>,
          <Trans>Redirect URI matching is exact. Wildcards are not accepted.</Trans>,
          <Trans>Authorization codes are one-time use.</Trans>,
          <Trans>Refresh tokens rotate on every use and replay revokes the token family.</Trans>,
          <Trans>
            DPoP-bound clients must present a valid DPoP proof for token and resource calls.
            Authorization request <code>dpop_jkt</code> is bound to authorization code exchange.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Support levels</Trans>,
        table: {
          headers: [<Trans>Level</Trans>, <Trans>OAuth and OIDC features</Trans>],
          rows: [
            [
              <Trans>Implemented</Trans>,
              <Trans>
                Authorization code, PKCE S256, refresh rotation, PAR, DPoP proof and{' '}
                <code>dpop_jkt</code> binding, dynamic client registration, ID tokens, userinfo,
                hybrid response types, signed JAR request objects, signed JARM responses, RAR
                <code>resource_access</code> authorization details, token-exchange refresh and ID
                token issuance, mTLS client authentication, and front-channel logout.
              </Trans>,
            ],
            [
              <Trans>Provider-ready</Trans>,
              <Trans>
                Device authorization polling, Session Management check_session, CIBA backchannel
                approval, FAPI 2.0 / Browser-Based Apps profile gates, OpenID Federation, and Shared
                Signals expose guarded-minimal or provider-ready subsets. GNAP, UMA, HEART,
                OpenID4VP, and OpenID4VCI return negative or 501 stubs until full profiles ship.
              </Trans>,
            ],
            [
              <Trans>Planned</Trans>,
              <Trans>
                Downstream SaaS OIDC uses the current generic OIDC baseline locally, but
                SaaS-specific production support still requires real SaaS L4.
              </Trans>,
            ],
            [
              <Trans>Deprecated or not supported</Trans>,
              <Trans>Implicit flow, password grant, plain PKCE, and wildcard redirects.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Role boundaries</Trans>,
        table: {
          headers: [<Trans>XID role</Trans>, <Trans>Current public status</Trans>],
          rows: [
            [
              <Trans>OIDC / OAuth identity provider for customer applications</Trans>,
              <Trans>
                Implemented in local and Worker routes with authorization code, PKCE S256, PAR,
                DPoP, JAR, JARM, RAR, discovery, JWKS, token, userinfo, introspection, and
                revocation coverage.
              </Trans>,
            ],
            [
              <Trans>Upstream enterprise OIDC relying party</Trans>,
              <Trans>
                Provider-ready for enterprise connections. Production support requires a real IdP
                configuration and callback L4.
              </Trans>,
            ],
            [
              <Trans>Social OAuth relying party</Trans>,
              <Trans>
                Provider-ready for GitHub, Google, Microsoft account, and Apple. See Social login
                for provider-specific boundaries.
              </Trans>,
            ],
            [
              <Trans>Downstream SaaS OIDC identity provider</Trans>,
              <Trans>
                Generic OIDC baseline is available locally. SaaS-specific app templates and real
                SaaS L4 are still required before production support claims.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Client types</Trans>,
        table: {
          headers: [<Trans>Client</Trans>, <Trans>Recommended flow</Trans>],
          rows: [
            [
              <Trans>Web application</Trans>,
              <Trans>Authorization code with server side token exchange.</Trans>,
            ],
            [<Trans>SPA</Trans>, <Trans>Authorization code with PKCE S256.</Trans>],
            [
              <Trans>Native app</Trans>,
              <Trans>Authorization code with PKCE S256 and claimed redirects.</Trans>,
            ],
            [
              <Trans>Machine to machine</Trans>,
              <Trans>Client credentials with scoped access.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Guarded or minimal OAuth and OIDC extensions</Trans>,
        table: {
          headers: [<Trans>Level</Trans>, <Trans>Status</Trans>],
          rows: [
            [
              <Trans>Assertion grants</Trans>,
              <Trans>
                JWT bearer and SAML bearer assertion grants are not enabled. Registration rejects
                assertion grant metadata until a trust root exists.
              </Trans>,
            ],
            [
              <Trans>GNAP, UMA, HEART, OpenID4VP, OpenID4VCI</Trans>,
              <Trans>
                Minimal route subsets and discovery-friendly metadata are exposed. Unsupported
                operations return explicit errors until full profile handlers ship.
              </Trans>,
            ],
          ],
        },
      },
    ],
  },
  {
    slug: 'enterprise-sso',
    title: <Trans>Enterprise SSO</Trans>,
    href: '/docs/enterprise-sso',
    summary: (
      <Trans>
        Configure upstream enterprise IdPs and track downstream SaaS SSO boundaries without
        overstating production support.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Two directions</Trans>,
        body: [
          <Trans>
            Inbound enterprise SSO means XID acts as the SAML service provider or OIDC relying party
            for a company IdP. Downstream SaaS SSO means XID acts as the SAML or OIDC identity
            provider for apps such as Slack, GitHub Enterprise Cloud, Microsoft custom apps,
            Atlassian, Salesforce, and Zoom.
          </Trans>,
          <Trans>
            Both directions are separate evidence lines. A local fake IdP or fake SaaS run verifies
            the implementation baseline, but only a real external IdP or SaaS admin run can support
            a production-supported claim.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Upstream enterprise IdP status</Trans>,
        table: {
          headers: [<Trans>Provider</Trans>, <Trans>Protocols</Trans>, <Trans>Status</Trans>],
          rows: [
            [
              <Trans>Microsoft Entra ID</Trans>,
              <Trans>SAML, OIDC, SCIM inbound</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>Okta</Trans>,
              <Trans>SAML, OIDC, SCIM inbound</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>Google Workspace</Trans>,
              <Trans>SAML, OIDC, SCIM inbound</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>OneLogin</Trans>,
              <Trans>SAML, OIDC, SCIM inbound</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>JumpCloud</Trans>,
              <Trans>SAML, OIDC, SCIM inbound</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>PingOne</Trans>,
              <Trans>SAML, OIDC</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>PingFederate</Trans>,
              <Trans>SAML, OIDC</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>AD FS</Trans>,
              <Trans>SAML, OIDC, WS-Fed legacy baseline</Trans>,
              <Trans>Implemented locally; real AD FS WS-Fed L4 missing.</Trans>,
            ],
            [
              <Trans>Shibboleth</Trans>,
              <Trans>SAML, OIDC</Trans>,
              <Trans>Provider-ready, missing real IdP L4.</Trans>,
            ],
            [
              <Trans>Keycloak</Trans>,
              <Trans>SAML, OIDC, LDAP legacy baseline</Trans>,
              <Trans>Implemented locally; native Kerberos bridge is documented-only.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Downstream SaaS SSO status</Trans>,
        table: {
          headers: [<Trans>SaaS</Trans>, <Trans>Direction</Trans>, <Trans>Status</Trans>],
          rows: [
            [
              <Trans>Slack</Trans>,
              <Trans>XID as SAML IdP</Trans>,
              <Trans>
                Provider-ready with local outbound SAML baseline; real Slack admin L4 missing.
              </Trans>,
            ],
            [
              <Trans>GitHub Enterprise Cloud</Trans>,
              <Trans>XID as SAML IdP</Trans>,
              <Trans>
                Provider-ready with local outbound SAML baseline; real GitHub Enterprise L4 missing.
              </Trans>,
            ],
            [
              <Trans>Microsoft custom enterprise app</Trans>,
              <Trans>XID as SAML or OIDC IdP</Trans>,
              <Trans>
                Provider-ready with generic SAML/OIDC baseline; real Entra custom app L4 missing.
              </Trans>,
            ],
            [
              <Trans>Atlassian</Trans>,
              <Trans>XID as SAML IdP</Trans>,
              <Trans>
                Provider-ready with local outbound SAML baseline; real Atlassian admin L4 missing.
              </Trans>,
            ],
            [
              <Trans>Salesforce</Trans>,
              <Trans>XID as SAML or OIDC IdP</Trans>,
              <Trans>
                Provider-ready with generic SAML/OIDC baseline; real Salesforce admin L4 missing.
              </Trans>,
            ],
            [
              <Trans>Zoom</Trans>,
              <Trans>XID as SAML or OIDC IdP</Trans>,
              <Trans>
                Provider-ready with generic SAML/OIDC baseline; real Zoom admin L4 missing.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Legacy protocol boundaries</Trans>,
        bullets: [
          <Trans>
            LDAP direct bind, WS-Federation, SWA password vaulting, header-based SSO, and directory
            connector framework are implemented locally with fake harness L3. Real AD/LDAP gateway,
            AD FS WS-Fed, target app vault, and Application Proxy L4 are still missing.
          </Trans>,
          <Trans>Linked sign-on, native IWA, and Kerberos termination are not supported.</Trans>,
          <Trans>SAML Single Logout is not supported.</Trans>,
          <Trans>
            Provider-ready rows must not be described as production-supported until real external L4
            evidence exists.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'social-login',
    title: <Trans>Social login</Trans>,
    href: '/docs/social-login',
    summary: (
      <Trans>
        Configure social OAuth providers while keeping provider-ready separate from production
        support.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Provider status</Trans>,
        body: [
          <Trans>
            Social login is provider-ready until real provider callback L4 exists. XID has local
            callback, profile mapping, nonce, policy, and organization gate coverage, but real
            provider secrets and callbacks are required before production-supported claims.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Provider</Trans>, <Trans>Protocol</Trans>, <Trans>Status</Trans>],
          rows: [
            [
              <Trans>GitHub</Trans>,
              <Trans>OAuth authorization code</Trans>,
              <Trans>Provider-ready, missing real GitHub callback L4.</Trans>,
            ],
            [
              <Trans>Google</Trans>,
              <Trans>OIDC authorization code</Trans>,
              <Trans>Provider-ready, missing real Google callback L4.</Trans>,
            ],
            [
              <Trans>Microsoft account</Trans>,
              <Trans>OIDC authorization code</Trans>,
              <Trans>Provider-ready, separate from Microsoft Entra ID.</Trans>,
            ],
            [
              <Trans>Apple</Trans>,
              <Trans>Sign in with Apple</Trans>,
              <Trans>Provider-ready, missing real Apple web configuration and callback L4.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Configuration contract</Trans>,
        bullets: [
          <Trans>
            Provider credentials are stored as secret references and are never returned to the
            browser.
          </Trans>,
          <Trans>
            Hosted Auth only displays enabled providers that have credentials and organization
            policy permission.
          </Trans>,
          <Trans>
            Callbacks verify state, nonce, issuer, audience, and email policy before creating or
            linking users.
          </Trans>,
          <Trans>GitHub social login is separate from GitHub Enterprise Cloud SAML or SCIM.</Trans>,
          <Trans>
            Microsoft account login is separate from Microsoft Entra ID enterprise SSO.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'management-api',
    title: <Trans>Management API</Trans>,
    href: '/docs/management-api',
    summary: <Trans>Use scoped API keys to manage organization resources from your backend.</Trans>,
    sections: [
      {
        heading: <Trans>Authentication</Trans>,
        body: [
          <Trans>
            Management API calls use <code>Authorization: Bearer sk_live_*</code> or
            <code>Authorization: Bearer sk_test_*</code>. Keys are scoped per organization and
            checked before every resource action.
          </Trans>,
        ],
        code: `curl https://xid.dev/v1/users \\
  -H 'Authorization: Bearer sk_live_xxx'`,
      },
      {
        heading: <Trans>Resources</Trans>,
        table: {
          headers: [<Trans>Resource</Trans>, <Trans>Capabilities</Trans>, <Trans>Status</Trans>],
          rows: [
            [
              <code key="path">/v1/users</code>,
              <Trans>Create, read, update, ban, unban, export, and remove users.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/organizations</code>,
              <Trans>Manage organizations, domains, branding, and settings.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/organizations/:orgId/memberships</code>,
              <Trans>List, create, update role, and remove members.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/organizations/:orgId/invitations</code>,
              <Trans>Create (with bulk limit), revoke, and list invitations.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/sessions</code>,
              <Trans>List, get, and revoke user sessions.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/applications</code>,
              <Trans>
                Register OAuth clients, redirect URIs, grants, token policy, and secrets.
              </Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/connections</code>,
              <Trans>Manage upstream enterprise SSO connections.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/directories</code>,
              <Trans>Create SCIM directories and rotate directory tokens.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/roles</code>,
              <Trans>Create, read, update, and delete custom roles.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/permissions</code>,
              <Trans>Create, read, update, and delete permissions.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/users/:userId/emailAddresses</code>,
              <Trans>Add, remove, and set primary email addresses.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/users/:userId/phoneNumbers</code>,
              <Trans>Add, remove, and set primary phone numbers.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/allowlist-identifiers</code>,
              <Trans>Create, delete, and list allowed email or domain identifiers.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/oauth-applications</code>,
              <Trans>Manage OAuth applications where XID acts as the identity provider.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/redirect-urls</code>,
              <Trans>Register and remove allowed redirect URL values.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/webhooks</code>,
              <Trans>Create, list, update, and delete webhook endpoints.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/api-keys</code>,
              <Trans>Create, list, and revoke organization API keys.</Trans>,
              <Trans>Implemented</Trans>,
            ],
            [
              <code key="path">/v1/billing</code>,
              <Trans>Read plans, manage subscriptions, and view payment history.</Trans>,
              <Trans>Planned</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Pagination and errors</Trans>,
        body: [
          <Trans>
            List endpoints return a data array and cursor metadata. Errors use structured JSON with
            a stable code, a human-readable message, and optional metadata for field validation.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'webhooks',
    title: <Trans>Webhooks</Trans>,
    href: '/docs/webhooks',
    summary: (
      <Trans>
        Subscribe to XID events and receive signed HTTP payloads when users, sessions, and
        organizations change.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Event naming</Trans>,
        body: [
          <Trans>
            Events follow the pattern <code>{'<object>.<action>'}</code>. Each event carries a
            stable type name, a unique <code>svix-id</code>, and an ISO 8601 timestamp.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Object</Trans>, <Trans>Actions</Trans>],
          rows: [
            [<code key="obj">user</code>, <Trans>created, updated, deleted</Trans>],
            [<code key="obj">session</code>, <Trans>created, ended, removed, revoked</Trans>],
            [<code key="obj">organization</code>, <Trans>created, updated, deleted</Trans>],
            [
              <code key="obj">organizationMembership</code>,
              <Trans>created, updated, deleted</Trans>,
            ],
            [
              <code key="obj">organizationInvitation</code>,
              <Trans>created, accepted, revoked</Trans>,
            ],
            [
              <code key="obj">organizationDomain</code>,
              <Trans>created, updated, deleted, verified, verification_failed</Trans>,
            ],
            [
              <code key="obj">authentication</code>,
              <Trans>
                password_succeeded, password_failed, passkey_succeeded, passkey_failed,
                mfa_succeeded, mfa_failed, oauth_succeeded, oauth_failed, sso_succeeded, sso_failed,
                magic_auth_succeeded, magic_auth_failed, email_verification_succeeded,
                email_verification_failed, radar_risk_detected
              </Trans>,
            ],
            [
              <code key="obj">connection</code>,
              <Trans>
                activated, deactivated, deleted, saml_certificate_renewed, renewal_required
              </Trans>,
            ],
            [
              <code key="obj">dsync</code>,
              <Trans>
                activated, deleted, user.created, user.updated, user.deleted, group.created,
                group.updated, group.deleted, group.user_added, group.user_removed
              </Trans>,
            ],
            [<code key="obj">role</code>, <Trans>created, updated, deleted</Trans>],
            [<code key="obj">permission</code>, <Trans>created, updated, deleted</Trans>],
            [
              <code key="obj">email</code>,
              <Trans>created (fired when the developer takes over sending)</Trans>,
            ],
            [
              <code key="obj">sms</code>,
              <Trans>created (fired when the developer takes over sending)</Trans>,
            ],
            [
              <code key="obj">billing</code>,
              <Trans>
                subscription.created, subscription.updated, paymentAttempt.succeeded,
                paymentAttempt.failed
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Payload structure</Trans>,
        body: [
          <Trans>
            Every webhook delivery is an HTTP POST with <code>Content-Type: application/json</code>.
            The body contains <code>type</code>, <code>data</code>, and top-level metadata headers.
          </Trans>,
        ],
        code: `{
  "type": "user.created",
  "data": {
    "id": "usr_01abc",
    "email_addresses": [{ "email_address": "alice@example.com" }],
    "created_at": 1700000000000
  }
}`,
      },
      {
        heading: <Trans>Signature verification</Trans>,
        body: [
          <Trans>
            XID signs every delivery with HMAC-SHA256. Verify the signature before processing the
            payload. Reject deliveries older than 5 minutes to prevent replay attacks.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Header</Trans>, <Trans>Description</Trans>],
          rows: [
            [
              <code key="h">svix-id</code>,
              <Trans>Unique message ID. Use this to deduplicate retried deliveries.</Trans>,
            ],
            [
              <code key="h">svix-timestamp</code>,
              <Trans>Unix seconds when the message was sent.</Trans>,
            ],
            [
              <code key="h">svix-signature</code>,
              <Trans>
                Base64-encoded HMAC-SHA256 of <code>{SVIX_SIGNATURE_INPUT}</code> using the endpoint
                signing secret.
              </Trans>,
            ],
          ],
        },
        code: `// Node.js / Cloudflare Workers example
async function verifyWebhook(request, secret) {
  const svixId = request.headers.get('svix-id')
  const svixTimestamp = request.headers.get('svix-timestamp')
  const svixSignature = request.headers.get('svix-signature')
  const body = await request.text()

  // Reject messages older than 5 minutes
  const ts = Number(svixTimestamp)
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new Error('webhook timestamp out of tolerance')
  }

  const signedContent = \`\${svixId}.\${svixTimestamp}.\${body}\`
  const keyData = Uint8Array.from(atob(secret), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  const msgData = new TextEncoder().encode(signedContent)

  // svix-signature may contain multiple comma-separated values
  for (const sig of svixSignature.split(' ')) {
    const prefix = 'v1,'
    if (!sig.startsWith(prefix)) continue
    const sigBytes = Uint8Array.from(atob(sig.slice(prefix.length)), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, msgData)
    if (valid) return JSON.parse(body)
  }
  throw new Error('invalid webhook signature')
}`,
      },
      {
        heading: <Trans>Retries and dead letters</Trans>,
        bullets: [
          <Trans>
            Failed deliveries are retried with exponential backoff. After the maximum retry count,
            the message is written to the dead-letter store in D1 for manual inspection.
          </Trans>,
          <Trans>
            Delivery is decoupled from the authentication path through Cloudflare Queues. A slow or
            unavailable endpoint does not affect login latency.
          </Trans>,
          <Trans>
            Use the <code>svix-id</code> header to deduplicate deliveries on your end. Retries carry
            the same <code>svix-id</code> as the original attempt.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Manual replay</Trans>,
        body: [
          <Trans>
            Use <code>POST /v1/webhooks/:endpointId/replay</code> to replay events by message ID or
            time range. Replayed events carry fresh <code>svix-id</code> values but preserve the
            original <code>type</code> and <code>data</code>.
          </Trans>,
        ],
        code: `# Replay events from the last hour
curl -X POST https://xid.dev/v1/webhooks/whe_xxx/replay \\
  -H 'Authorization: Bearer sk_live_xxx' \\
  -H 'Content-Type: application/json' \\
  -d '{ "since": "2024-01-01T00:00:00Z", "until": "2024-01-01T01:00:00Z" }'`,
      },
      {
        heading: <Trans>Events API</Trans>,
        body: [
          <Trans>
            In addition to push webhooks, XID exposes an ordered, immutable event stream with cursor
            pagination at <code>GET /v1/events</code>. Pull the stream to build reliable
            synchronization without missing events between webhook retries.
          </Trans>,
        ],
        code: `curl 'https://xid.dev/v1/events?limit=100&after=evt_xxx' \\
  -H 'Authorization: Bearer sk_live_xxx'`,
      },
    ],
  },
  {
    slug: 'branding',
    title: <Trans>Branding</Trans>,
    href: '/docs/branding',
    summary: (
      <Trans>
        Customize the Hosted Auth appearance with colors, fonts, radius, logos, and custom CSS.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Branding options</Trans>,
        body: [
          <Trans>
            Branding configuration controls the visual appearance of the Hosted Auth pages, consent
            screen, and email templates. Each organization can override the instance-level defaults.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Option</Trans>, <Trans>Description</Trans>],
          rows: [
            [
              <Trans>Primary color</Trans>,
              <Trans>
                Main action color used for buttons, links, and focus rings. Accepts CSS hex or oklch
                values.
              </Trans>,
            ],
            [
              <Trans>Background color</Trans>,
              <Trans>Page background for Hosted Auth screens.</Trans>,
            ],
            [
              <Trans>Accent color</Trans>,
              <Trans>Secondary highlight color used for labels and decorative elements.</Trans>,
            ],
            [
              <Trans>Border radius</Trans>,
              <Trans>
                Corner radius applied to cards, inputs, and buttons. Choose from none, small,
                medium, large, or full.
              </Trans>,
            ],
            [
              <Trans>Font family</Trans>,
              <Trans>
                Google Fonts name or a custom CDN font URL. Falls back to the system sans-serif
                stack.
              </Trans>,
            ],
            [
              <Trans>Logo (light)</Trans>,
              <Trans>PNG or SVG displayed on light-theme pages. Stored in R2.</Trans>,
            ],
            [
              <Trans>Logo (dark)</Trans>,
              <Trans>
                PNG or SVG displayed on dark-theme pages. Falls back to the light logo when not set.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Per-organization branding</Trans>,
        body: [
          <Trans>
            Each organization can override instance-level branding with its own logo, colors, and
            background. The Login Worker resolves brand configuration per organization, falling back
            to the instance defaults when no organization override is set. Brand cache reads
            complete in under 2 ms at P50.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Management API endpoint</Trans>,
        body: [
          <Trans>
            Update organization branding with a PATCH request. Only fields present in the request
            body are changed. Pass <code>null</code> to clear a field and restore the parent
            default.
          </Trans>,
        ],
        code: `curl -X PATCH https://xid.dev/v1/organizations/org_xxx/branding \\
  -H 'Authorization: Bearer sk_live_xxx' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "primary_color": "#6366f1",
    "border_radius": "medium",
    "font_family": "Inter",
    "hide_xid_branding": true
  }'`,
      },
      {
        heading: <Trans>Custom CSS constraints</Trans>,
        bullets: [
          <Trans>Maximum size is 50 KB per organization.</Trans>,
          <Trans>
            The CSP filter strips <code>@import</code> rules and <code>url()</code> references that
            point outside the allowlist. Only pure CSS property declarations survive.
          </Trans>,
          <Trans>
            External script execution from within custom CSS is blocked. Use the custom CSS only for
            visual overrides, not for behavioral logic.
          </Trans>,
          <Trans>
            Changes are previewed in an iframe sandbox before being published. Preview and live
            states are kept separate.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Email template branding</Trans>,
        body: [
          <Trans>
            Transactional email templates (verification, magic link, OTP, password reset, and
            invitations) pick up the organization logo and primary color automatically. Custom email
            HTML templates can be uploaded per organization through the console.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'scim',
    title: <Trans>SCIM API reference</Trans>,
    href: '/docs/scim',
    summary: <Trans>SCIM 2.0 endpoint contract for provisioning users and groups into XID.</Trans>,
    sections: [
      {
        heading: <Trans>Base URL</Trans>,
        body: [
          <Trans>
            XID exposes organization-scoped SCIM 2.0 APIs under{' '}
            <code>/scim/v2/organizations/{'{organization_id}'}</code>. User and group resources are
            addressed with the organization ID in the path.
          </Trans>,
          <>
            <Trans>Configure your identity provider with the base URL</Trans>{' '}
            <code>https://xid.dev/scim/v2/organizations/{'{organization_id}'}</code>{' '}
            <Trans>
              and the directory token shown once when you create or rotate the directory.
            </Trans>
          </>,
        ],
        code: `curl https://xid.dev/scim/v2/organizations/{organization_id}/Users \\
  -H 'Authorization: Bearer scim_xxx' \\
  -H 'Content-Type: application/scim+json'`,
      },
      {
        heading: <Trans>Authentication</Trans>,
        body: [
          <Trans>
            SCIM calls use a directory bearer token created from the Management API. XID stores only
            a hash of the token and returns the plaintext token once when it is created or rotated.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Header</Trans>, <Trans>Value</Trans>, <Trans>Notes</Trans>],
          rows: [
            [
              <code key="header">Authorization</code>,
              <code key="value">Bearer scim_xxx</code>,
              <Trans>Required for organization-scoped user and group endpoints.</Trans>,
            ],
            [
              <code key="header">Content-Type</code>,
              <code key="value">application/scim+json</code>,
              <Trans>Required for POST, PUT, and PATCH requests.</Trans>,
            ],
            [
              <code key="header">Accept</code>,
              <code key="value">application/scim+json</code>,
              <Trans>Recommended for all SCIM clients.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Endpoints</Trans>,
        table: {
          headers: [<Trans>Endpoint</Trans>, <Trans>Methods</Trans>, <Trans>Use</Trans>],
          rows: [
            [
              <code key="path">/scim/v2/ServiceProviderConfig</code>,
              <code key="methods">GET</code>,
              <Trans>ServiceProviderConfig response for SCIM client discovery.</Trans>,
            ],
            [
              <code key="path">/scim/v2/Schemas</code>,
              <code key="methods">GET</code>,
              <Trans>User and Group schema metadata.</Trans>,
            ],
            [
              <code key="path">/scim/v2/ResourceTypes</code>,
              <code key="methods">GET</code>,
              <Trans>Supported SCIM resource types.</Trans>,
            ],
            [
              <code key="path">/scim/v2/organizations/{'{organization_id}'}/Users</code>,
              <code key="methods">GET, POST</code>,
              <Trans>Create and list directory users.</Trans>,
            ],
            [
              <code key="path">
                /scim/v2/organizations/{'{organization_id}'}/Users/{'{id}'}
              </code>,
              <code key="methods">GET, PUT, PATCH, DELETE</code>,
              <Trans>Read, replace, patch, or deprovision one directory user.</Trans>,
            ],
            [
              <code key="path">/scim/v2/organizations/{'{organization_id}'}/Groups</code>,
              <code key="methods">GET, POST</code>,
              <Trans>Create and list directory groups.</Trans>,
            ],
            [
              <code key="path">
                /scim/v2/organizations/{'{organization_id}'}/Groups/{'{id}'}
              </code>,
              <code key="methods">GET, PUT, PATCH, DELETE</code>,
              <Trans>Read, replace, patch, or remove one directory group.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>User resource</Trans>,
        body: [
          <Trans>
            User resources use <code>userName</code> as the external identifier. Email values,
            profile name fields, active state, and enterprise extension fields are preserved in the
            SCIM raw profile.
          </Trans>,
        ],
        table: {
          headers: [<Trans>SCIM field</Trans>, <Trans>XID behavior</Trans>],
          rows: [
            [<code key="field">id</code>, <Trans>Stable XID directory user ID.</Trans>],
            [
              <code key="field">userName</code>,
              <Trans>Required. Must be unique inside the directory.</Trans>,
            ],
            [
              <code key="field">active</code>,
              <Trans>
                <code>false</code> deprovisions the user and revokes active sessions.
              </Trans>,
            ],
            [
              <code key="field">emails</code>,
              <Trans>Primary email is used for matching and account linking.</Trans>,
            ],
            [
              <code key="field">urn:ietf:params:scim:schemas:extension:enterprise:2.0:User</code>,
              <Trans>Stored and returned for enterprise attributes such as department.</Trans>,
            ],
          ],
        },
        code: `{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "alice@example.com",
  "active": true,
  "name": { "givenName": "Alice", "familyName": "Lee" },
  "emails": [{ "value": "alice@example.com", "primary": true }]
}`,
      },
      {
        heading: <Trans>Group resource</Trans>,
        body: [
          <Trans>
            Group resources use <code>displayName</code> as the unique directory group name. Members
            reference SCIM user IDs and are synchronized idempotently.
          </Trans>,
        ],
        code: `{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "displayName": "Engineering",
  "members": [
    { "value": "dir_user_123", "display": "alice@example.com" }
  ]
}`,
      },
      {
        heading: <Trans>Filtering, sorting, and pagination</Trans>,
        body: [
          <Trans>
            XID supports SCIM filter grammar with <code>and</code>, <code>or</code>,{' '}
            <code>not</code>, and comparison operators (<code>eq</code>, <code>ne</code>,{' '}
            <code>co</code>, <code>sw</code>, <code>ew</code>, <code>gt</code>, <code>ge</code>,{' '}
            <code>lt</code>, <code>le</code>, <code>pr</code>). Unsupported expressions return{' '}
            <code>invalidFilter</code>. List responses use SCIM 1-based pagination with{' '}
            <code>startIndex</code>, <code>count</code>, and <code>totalResults</code>, plus
            optional <code>sortBy</code> and <code>sortOrder</code>.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Query</Trans>, <Trans>Support</Trans>],
          rows: [
            [
              <code key="query">filter=userName eq "alice@example.com"</code>,
              <Trans>Find one user by userName.</Trans>,
            ],
            [
              <code key="query">filter=displayName eq "Engineering"</code>,
              <Trans>Find one group by displayName.</Trans>,
            ],
            [
              <code key="query">filter=userName sw "alice" and active eq true</code>,
              <Trans>Combine logical and comparison operators.</Trans>,
            ],
            [
              <code key="query">sortBy=userName&amp;sortOrder=ascending</code>,
              <Trans>Sort Users or Groups list results.</Trans>,
            ],
            [
              <code key="query">startIndex=1&amp;count=100</code>,
              <Trans>Return up to 100 resources from the first result.</Trans>,
            ],
            [
              <code key="query">attributes=userName,emails.value</code>,
              <Trans>Return only schemas, id, and the requested SCIM attributes.</Trans>,
            ],
            [
              <code key="query">excludedAttributes=emails,meta</code>,
              <Trans>Return the default resource without the excluded SCIM attributes.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Bulk operations</Trans>,
        body: [
          <Trans>
            <code>POST /scim/v2/organizations/{'{organization_id}'}/Bulk</code> accepts a{' '}
            <code>BulkRequest</code> with up to 100 operations and a 1&nbsp;MiB payload limit.
            Responses return per-operation HTTP status in a <code>BulkResponse</code> even when some
            operations fail.
          </Trans>,
        ],
        code: `{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
  "Operations": [
    {
      "method": "POST",
      "path": "/Users",
      "bulkId": "user1",
      "data": { "userName": "alice@example.com", "active": true }
    }
  ]
}`,
      },
      {
        heading: <Trans>ETag and If-Match</Trans>,
        body: [
          <Trans>
            Resource GET responses include <code>ETag: W/&quot;{'<meta.version>'}&quot;</code> from{' '}
            <code>meta.version</code>. <code>PUT</code> and <code>PATCH</code> require an{' '}
            <code>If-Match</code> header matching the current version; missing headers return{' '}
            <code>428</code> and mismatches return <code>412</code>.
          </Trans>,
        ],
      },
      {
        heading: <Trans>PATCH operations</Trans>,
        body: [
          <Trans>
            PATCH requests use <code>urn:ietf:params:scim:api:messages:2.0:PatchOp</code>. XID
            supports <code>add</code>, <code>replace</code>, and <code>remove</code> for writable
            profile fields and group memberships.
          </Trans>,
        ],
        code: `{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    { "op": "replace", "path": "active", "value": false }
  ]
}`,
      },
      {
        heading: <Trans>Error responses</Trans>,
        body: [
          <Trans>
            SCIM errors return <code>application/scim+json</code> with the SCIM Error schema, HTTP
            status, detail, and optional <code>scimType</code>.
          </Trans>,
        ],
        code: `{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "409",
  "scimType": "uniqueness",
  "detail": "userName already exists"
}`,
      },
      {
        heading: <Trans>ServiceProviderConfig capabilities</Trans>,
        bullets: [
          <Trans>
            <code>ServiceProviderConfig</code> advertises <code>sort.supported=true</code>,{' '}
            <code>bulk.supported=true</code>, and <code>etag.supported=true</code>.
          </Trans>,
          <Trans>
            XID exposes inbound SCIM Service Provider endpoints for external IdPs. Downstream SaaS
            SCIM push clients have local fake-SaaS evidence, but production support still requires
            real SaaS admin L4.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Deprovisioning behavior</Trans>,
        bullets: [
          <Trans>
            Directory token rotation keeps the previous token valid for a short grace window.
          </Trans>,
          <>
            <code>active=false</code> <Trans>and</Trans> <code>DELETE /Users/{'{id}'}</code>{' '}
            <Trans>deprovision the user and revoke active sessions.</Trans>
          </>,
          <Trans>
            Group membership updates are idempotent. Unknown members can be resolved after the user
            arrives from the identity provider.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'saml',
    title: <Trans>SAML SSO</Trans>,
    href: '/docs/saml',
    summary: <Trans>Connect enterprise identity providers using SAML 2.0.</Trans>,
    sections: [
      {
        heading: <Trans>Service provider endpoints</Trans>,
        table: {
          headers: [<Trans>Endpoint</Trans>, <Trans>Description</Trans>],
          rows: [
            [
              <code key="path">/sso/hrd</code>,
              <Trans>Find the enterprise connection for a verified email domain.</Trans>,
            ],
            [
              <code key="path">/sso/saml/{'{connection}'}/metadata</code>,
              <Trans>SP metadata XML for the configured connection.</Trans>,
            ],
            [
              <code key="path">/sso/saml/{'{connection}'}/login</code>,
              <Trans>SP-initiated AuthnRequest redirect to the IdP.</Trans>,
            ],
            [
              <code key="path">/sso/saml/{'{connection}'}/acs</code>,
              <Trans>ACS endpoint for signed or encrypted SAML responses.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Security model</Trans>,
        body: [
          <Trans>
            SAML is provider-ready: local and fake-IdP evidence covers the current Worker routes,
            and production readiness still requires a real IdP connection without recording
            SAMLResponse values or provider secrets.
          </Trans>,
        ],
        bullets: [
          <Trans>
            IdP certificates are stored on the connection. Browser-supplied KeyInfo is ignored.
          </Trans>,
          <Trans>
            Assertions are validated for issuer, audience, recipient, time window, InResponseTo, and
            replay.
          </Trans>,
          <Trans>
            EncryptedAssertion uses the configured SP decrypt key, then still requires the decrypted
            assertion signature to verify.
          </Trans>,
          <Trans>
            XML security precheck and signature structure whitelist are covered locally. Full XSD
            validation and SAML Single Logout are not public-supported yet.
          </Trans>,
          <Trans>
            XID currently acts as the SAML service provider for enterprise IdPs. Outbound SAML IdP
            for downstream SaaS apps has local fake-SaaS evidence, but production support still
            requires real SaaS admin L4.
          </Trans>,
          <Trans>
            JIT provisioning can create or update users when the connection policy allows it.
          </Trans>,
          <Trans>
            SCIM remains the recommended source for deprovisioning and group membership lifecycle.
          </Trans>,
        ],
      },
    ],
  },
  {
    slug: 'sdks',
    title: <Trans>SDKs</Trans>,
    href: '/docs/sdks',
    summary: (
      <Trans>
        TypeScript packages and locally verified native SDKs for server, web, mobile, and desktop.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Status legend</Trans>,
        body: [
          <Trans>
            Every SDK below carries one of two status labels, aligned with the XID platform support
            matrix. Neither label is a production-readiness claim.
          </Trans>,
        ],
        table: {
          headers: [<Trans>Status</Trans>, <Trans>Meaning</Trans>],
          rows: [
            [
              <Trans>Current package</Trans>,
              <Trans>
                TypeScript package maintained in the XID repository with source, tests, and
                workspace wiring.
              </Trans>,
            ],
            [
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Native SDK that compiles and passes its unit test suite on a local toolchain. A
                round-trip against a real production IdP still requires manual verification.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Server-side SDKs</Trans>,
        body: [
          <Trans>
            Web-standard runtimes (Cloudflare Workers, Node.js, Bun, Deno) share @xid-kit/backend
            via Web Crypto. Other languages get native SDKs. All do networkless JWT verification,
            request authentication, and webhook verification.
          </Trans>,
        ],
        table: {
          headers: [
            <Trans>Runtime or language</Trans>,
            <Trans>Package or directory</Trans>,
            <Trans>Status</Trans>,
            <Trans>Responsibility</Trans>,
          ],
          rows: [
            [
              <Trans>Cloudflare Workers</Trans>,
              <code key="pkg">@xid-kit/backend</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Node.js</Trans>,
              <code key="pkg">@xid-kit/backend</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Bun</Trans>,
              <code key="pkg">@xid-kit/backend</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Deno</Trans>,
              <code key="pkg">@xid-kit/backend</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Go</Trans>,
              <code key="pkg">sdk/go</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Java</Trans>,
              <code key="pkg">sdk/java</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Rust</Trans>,
              <code key="pkg">sdk/rust</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>PHP</Trans>,
              <code key="pkg">sdk/php</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Ruby</Trans>,
              <code key="pkg">sdk/ruby</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>Python</Trans>,
              <code key="pkg">sdk/python</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
            [
              <Trans>.NET</Trans>,
              <code key="pkg">sdk/dotnet</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>
                Networkless JWT verification, request authentication, and webhook verification.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Client SDKs: web frameworks</Trans>,
        table: {
          headers: [
            <Trans>Framework</Trans>,
            <Trans>Package or directory</Trans>,
            <Trans>Status</Trans>,
            <Trans>Responsibility</Trans>,
          ],
          rows: [
            [
              <Trans>Vanilla JS / Web</Trans>,
              <code key="pkg">@xid-kit/core</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Browser client, session store, token cache, and Management API helpers.
              </Trans>,
            ],
            [
              <Trans>React</Trans>,
              <code key="pkg">@xid-kit/react</code>,
              <Trans>Current package</Trans>,
              <Trans>Provider, hooks, control components, user UI, and organization UI.</Trans>,
            ],
            [
              <Trans>Next.js</Trans>,
              <code key="pkg">@xid-kit/nextjs</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Middleware, App Router helpers, Pages Router helpers, and React re-exports.
              </Trans>,
            ],
            [
              <Trans>Vue</Trans>,
              <code key="pkg">@xid-kit/vue</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>Nuxt</Trans>,
              <code key="pkg">@xid-kit/nuxt</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>Svelte / SvelteKit</Trans>,
              <code key="pkg">@xid-kit/svelte</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>Angular</Trans>,
              <code key="pkg">@xid-kit/angular</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>Remix</Trans>,
              <code key="pkg">@xid-kit/remix</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>Astro</Trans>,
              <code key="pkg">@xid-kit/astro</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
            [
              <Trans>SolidJS</Trans>,
              <code key="pkg">@xid-kit/solid</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Provider, hooks or composables, and prebuilt user and organization components.
              </Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Client SDKs: mobile</Trans>,
        table: {
          headers: [
            <Trans>Platform</Trans>,
            <Trans>Package or directory</Trans>,
            <Trans>Status</Trans>,
            <Trans>Responsibility</Trans>,
          ],
          rows: [
            [
              <Trans>React Native</Trans>,
              <code key="pkg">@xid-kit/react-native</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Hosted redirect, deep link callback, PKCE S256, and secure storage adapter contract.
              </Trans>,
            ],
            [
              <Trans>Expo</Trans>,
              <code key="pkg">@xid-kit/expo</code>,
              <Trans>Current package</Trans>,
              <Trans>Expo Router integration, AuthSession, and SecureStore adapter.</Trans>,
            ],
            [
              <Trans>Flutter</Trans>,
              <code key="pkg">sdk/flutter</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>Hosted redirect, app link callback, and secure storage adapter.</Trans>,
            ],
            [
              <Trans>iOS</Trans>,
              <code key="pkg">sdk/ios</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>ASWebAuthenticationSession, Keychain storage, and PKCE S256.</Trans>,
            ],
            [
              <Trans>Android</Trans>,
              <code key="pkg">sdk/android</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>Custom Tabs, App Links, Keystore-backed storage, and PKCE S256.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Client SDKs: desktop</Trans>,
        table: {
          headers: [
            <Trans>Platform</Trans>,
            <Trans>Package or directory</Trans>,
            <Trans>Status</Trans>,
            <Trans>Responsibility</Trans>,
          ],
          rows: [
            [
              <Trans>macOS</Trans>,
              <code key="pkg">sdk/macos</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>ASWebAuthenticationSession, Keychain storage, and PKCE S256.</Trans>,
            ],
            [
              <Trans>Windows</Trans>,
              <code key="pkg">sdk/windows</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>WebView2 redirect, DPAPI secure storage, and PKCE S256.</Trans>,
            ],
            [
              <Trans>Linux</Trans>,
              <code key="pkg">sdk/linux</code>,
              <Trans>Implemented · verified locally</Trans>,
              <Trans>System browser redirect, Secret Service storage, and PKCE S256.</Trans>,
            ],
            [
              <Trans>Electron</Trans>,
              <code key="pkg">@xid-kit/electron</code>,
              <Trans>Current package</Trans>,
              <Trans>
                Main and renderer bridge, safeStorage, and loopback or custom scheme callbacks.
              </Trans>,
            ],
            [
              <Trans>Tauri</Trans>,
              <code key="pkg">@xid-kit/tauri</code>,
              <Trans>Current package</Trans>,
              <Trans>Rust backend bridge, OS keychain, and PKCE S256.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Shared native contract</Trans>,
        bullets: [
          <Trans>
            Native public clients use authorization code with PKCE S256. Implicit flow and password
            grant are not supported.
          </Trans>,
          <Trans>
            Redirect callbacks are claimed app links, universal links, custom schemes, or platform
            equivalent callback URLs.
          </Trans>,
          <Trans>
            Storage adapters keep refresh tokens or session cache values in platform secure storage
            and never store client secrets.
          </Trans>,
          <Trans>
            JS and TS native SDKs (React Native, Expo) use a React provider plus hooks model:
            XidProvider, useSignIn, and useSignOut.
          </Trans>,
          <Trans>
            Other native SDKs (iOS, Android, Flutter, desktop) use a functional configure, signIn,
            and handleRedirect API surface.
          </Trans>,
        ],
      },
      {
        heading: <Trans>Package guides</Trans>,
        body: [
          <Trans>
            Each SDK has a dedicated reference page with install steps, API tables, and copy-paste
            examples. The SDK packages group in the sidebar lists every reference page; the most
            used web packages are:
          </Trans>,
        ],
        bullets: [
          <Trans>
            <Link to="/docs/sdks/core">@xid-kit/core</Link> — browser session, tokens, Management
            API helpers.
          </Trans>,
          <Trans>
            <Link to="/docs/sdks/backend">@xid-kit/backend</Link> — networkless JWT verify, request
            auth, webhooks.
          </Trans>,
          <Trans>
            <Link to="/docs/sdks/react">@xid-kit/react</Link> — provider, hooks, control and UI
            components.
          </Trans>,
          <Trans>
            <Link to="/docs/sdks/nextjs">@xid-kit/nextjs</Link> — middleware and App/Pages Router
            server helpers.
          </Trans>,
          <Trans>
            <Link to="/docs/sdks/react-native">@xid-kit/react-native</Link> — Hosted Auth redirect,
            PKCE S256, secure token storage for native apps.
          </Trans>,
        ],
      },
    ],
  },
  ...SDK_DETAIL_DOCS,
  {
    slug: 'self-hosting',
    title: <Trans>Self-hosting</Trans>,
    href: '/docs/self-hosting',
    summary: (
      <Trans>
        Run XID on your own Cloudflare account with Workers, D1, KV, R2, queues, and Durable
        Objects.
      </Trans>
    ),
    sections: [
      {
        heading: <Trans>Required bindings</Trans>,
        table: {
          headers: [<Trans>Binding</Trans>, <Trans>Purpose</Trans>],
          rows: [
            [<code key="binding">DB</code>, <Trans>D1 relational storage.</Trans>],
            [
              <code key="binding">CACHE</code>,
              <Trans>KV cache for discovery, keys, and branding.</Trans>,
            ],
            [
              <code key="binding">STORAGE</code>,
              <Trans>R2 object storage for assets and exports.</Trans>,
            ],
            [<code key="binding">EMAIL_QUEUE</code>, <Trans>Transactional email queue.</Trans>],
            [<code key="binding">AUDIT_QUEUE</code>, <Trans>Audit event queue.</Trans>],
            [
              <code key="binding">SESSION_REVOCATION</code>,
              <Trans>Durable Object for session revocation state.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Required secrets</Trans>,
        table: {
          headers: [<Trans>Secret</Trans>, <Trans>Purpose</Trans>],
          rows: [
            [
              <code key="secret">KEK</code>,
              <Trans>Envelope encryption for instance signing keys.</Trans>,
            ],
            [
              <code key="secret">PEPPER</code>,
              <Trans>Server side password and token hashing pepper.</Trans>,
            ],
            [
              <code key="secret">BOOTSTRAP_TOKEN</code>,
              <Trans>Protects instance initialization in self-hosted deployments.</Trans>,
            ],
          ],
        },
      },
      {
        heading: <Trans>Deployment checks</Trans>,
        body: [
          <Trans>
            After deployment, verify health, OIDC discovery, JWKS, Hosted Auth configuration, and at
            least one authorization redirect from the instance issuer.
          </Trans>,
        ],
        code: `curl https://xid.dev/v1/health
curl https://xid.dev/.well-known/openid-configuration
curl https://xid.dev/jwks
curl https://xid.dev/auth/config`,
      },
    ],
  },
]

const bySlug = new Map(DOCS.map((doc) => [doc.slug, doc]))

// 全宽三栏版式:左目录 / 流体正文 / 右侧本页小节锚点。布局容器零 padding,边距由各栏自持;
// 分栏靠 1px 竖向 hairline,分节靠 1px 横向 hairline,无卡片包裹无阴影。
// 区头/表头/序号统一 mono microlabel 签名(0.6875rem / 500 / 0.08em / uppercase,数字 tabular-nums)。
const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-surface'],
  },
  headerInner: {
    width: '100%',
    minHeight: '4rem',
    paddingInline: 'clamp(1.25rem, 2vw, 2.5rem)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  brand: {
    display: 'inline-flex',
    alignItems: 'center',
    textDecorationLine: 'none',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  navLink: {
    color: {
      default: tokens['--xid-fg'],
      ':hover': tokens['--xid-primary'],
      ':active': tokens['--xid-accent'],
    },
    fontSize: '0.875rem',
    fontWeight: 500,
    textDecorationLine: 'none',
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  // 三栏 grid:目录 | 正文 | 锚点列。gap 为 0,栏间分隔由 aside 右缘线与 toc 左缘线承担。
  shell: {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: {
      default: 'clamp(16rem, 15vw, 22rem) minmax(0, 1fr)',
      '@media (max-width: 760px)': 'minmax(0, 1fr)',
    },
  },
  shellWithToc: {
    gridTemplateColumns: {
      default: 'clamp(16rem, 15vw, 22rem) minmax(0, 1fr) clamp(14rem, 13vw, 19rem)',
      '@media (max-width: 1100px)': 'clamp(16rem, 15vw, 22rem) minmax(0, 1fr)',
      '@media (max-width: 760px)': 'minmax(0, 1fr)',
    },
  },
  aside: {
    minWidth: 0,
    borderInlineEndWidth: {
      default: '1px',
      '@media (max-width: 760px)': 0,
    },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
    paddingInlineStart: {
      default: 'clamp(1.25rem, 2vw, 2.5rem)',
      '@media (max-width: 760px)': '1.25rem',
    },
    paddingInlineEnd: {
      default: 'clamp(1.25rem, 1.6vw, 2rem)',
      '@media (max-width: 760px)': '1.25rem',
    },
    paddingBlock: {
      default: 0,
      // 窄屏折叠按钮上方需要空间;1.25rem 满足 hairline 邻接规则(sticky 头 hairline -> 按钮文本)
      '@media (max-width: 760px)': '1.25rem 0',
    },
  },
  sideSticky: {
    position: {
      default: 'sticky',
      '@media (max-width: 760px)': 'static',
    },
    top: '4rem',
    maxHeight: {
      default: 'calc(100dvh - 4rem)',
      '@media (max-width: 760px)': 'none',
    },
    overflowY: {
      default: 'auto',
      '@media (max-width: 760px)': 'visible',
    },
    paddingBlock: {
      default: 'clamp(2.25rem, 3vw, 4rem) 3rem',
      '@media (max-width: 760px)': 0,
    },
  },
  microlabel: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  navToggle: {
    display: {
      default: 'none',
      '@media (max-width: 760px)': 'flex',
    },
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: tokens['--xid-border'],
      ':hover': tokens['--xid-border-strong'],
    },
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':active': tokens['--xid-muted'],
    },
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  navChevron: {
    width: '0.4375rem',
    height: '0.4375rem',
    marginTop: '-0.1875rem',
    borderRightWidth: '1.5px',
    borderRightStyle: 'solid',
    borderRightColor: 'currentColor',
    borderBottomWidth: '1.5px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'currentColor',
    transform: 'rotate(45deg)',
    transitionProperty: 'transform',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'ease-out',
  },
  navChevronOpen: {
    marginTop: '0.125rem',
    transform: 'rotate(225deg)',
  },
  sideNav: {
    display: {
      default: 'block',
      '@media (max-width: 760px)': 'none',
    },
    marginTop: {
      default: 0,
      '@media (max-width: 760px)': '0.75rem',
    },
  },
  sideNavOpen: {
    display: 'block',
  },
  sideGroupLabel: {
    margin: '0 0 0.75rem',
    paddingInlineStart: {
      default: '1rem',
      '@media (max-width: 760px)': 0,
    },
  },
  sideGroupLabelGap: {
    marginTop: '2.25rem',
  },
  // 窄屏折叠按钮本身就是"开发者文档"标签,展开后第一组 label 与之重复,移动隐藏。
  sideGroupLabelFirst: {
    display: {
      default: 'block',
      '@media (max-width: 760px)': 'none',
    },
  },
  // 目录列表:1px rail 贴左,active 项以 2px 主色覆盖 rail,层次不靠底色块。
  sideList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    borderInlineStartWidth: {
      default: '1px',
      '@media (max-width: 760px)': 0,
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
  },
  sideLink: {
    display: 'block',
    marginInlineStart: {
      default: '-1px',
      '@media (max-width: 760px)': 0,
    },
    borderInlineStartWidth: {
      default: '2px',
      '@media (max-width: 760px)': 0,
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: {
      default: 'transparent',
      ':hover': tokens['--xid-border-strong'],
      ':active': tokens['--xid-accent'],
    },
    paddingBlock: '0.375rem',
    paddingInlineStart: {
      default: '0.9375rem',
      '@media (max-width: 760px)': 0,
    },
    paddingInlineEnd: '0.5rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    lineHeight: 1.45,
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
      ':active': tokens['--xid-fg'],
    },
    textDecorationLine: 'none',
    transitionProperty: 'color, border-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  sideLinkActive: {
    color: tokens['--xid-fg'],
    fontWeight: 600,
    borderInlineStartColor: tokens['--xid-primary'],
  },
  content: {
    minWidth: 0,
    paddingBlock: {
      // hairline 邻接 >= 1.25rem:sticky 头区底线到首屏内容 >= 1.25rem
      default: 'clamp(2.25rem, 3vw, 4rem) 6rem',
      '@media (max-width: 760px)': '1.5rem 3.5rem',
    },
    paddingInline: {
      default: 'clamp(1.75rem, 3.2vw, 6rem)',
      '@media (max-width: 760px)': '1.25rem',
    },
  },
  // 头区:不对称 7/5 双列,左 display 标题、右摘要底缘对齐;窄屏堆叠。
  hero: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 7fr) minmax(0, 5fr)',
      '@media (max-width: 1100px)': 'minmax(0, 1fr)',
    },
    columnGap: 'clamp(2.5rem, 5vw, 8rem)',
    rowGap: '1.25rem',
    alignItems: 'end',
    marginBottom: {
      default: 'clamp(2.75rem, 4vw, 5.5rem)',
      '@media (max-width: 760px)': '2rem',
    },
  },
  docHeader: {
    marginBottom: 0,
  },
  eyebrow: {
    margin: 0,
  },
  title: {
    marginBlock: '0.875rem 0',
    fontSize: {
      default: 'clamp(2.25rem, 1.05rem + 2.5vw, 4.25rem)',
      '@media (max-width: 760px)': 'clamp(1.75rem, 7vw, 2.25rem)',
    },
    fontWeight: 650,
    lineHeight: 1.04,
    letterSpacing: '-0.028em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  titleDetail: {
    fontSize: {
      default: 'clamp(2rem, 1rem + 2vw, 3.5rem)',
      '@media (max-width: 760px)': 'clamp(1.625rem, 6.5vw, 2rem)',
    },
  },
  lead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: 'clamp(0.9375rem, 0.85rem + 0.25vw, 1.125rem)',
    lineHeight: 1.6,
    textWrap: 'pretty',
    maxWidth: '38rem',
  },
  leadAlign: {
    paddingBottom: {
      default: '0.5rem',
      '@media (max-width: 1100px)': 0,
    },
  },
  // 索引 = 行式列表,宽屏双列编排:区头压 border-strong 线,行间 1px hairline,行高按行轨对齐。
  indexGroupGap: {
    marginTop: 'clamp(2.75rem, 3.5vw, 4.5rem)',
  },
  indexHead: {
    margin: 0,
    // hairline 邻接 >= 1.25rem:microlabel 文本距底线 1.25rem
    paddingBlockStart: '0.75rem',
    paddingBlockEnd: '1.25rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border-strong'],
  },
  indexList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      '@media (max-width: 1280px)': 'minmax(0, 1fr)',
    },
    columnGap: 'clamp(3rem, 5vw, 7rem)',
  },
  indexItem: {
    minWidth: 0,
    display: 'grid',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  indexRow: {
    display: 'grid',
    alignContent: 'start',
    rowGap: '0.375rem',
    // hairline 邻接 >= 1.25rem:行文本与行间线各保 1.25rem
    paddingBlock: '1.25rem',
    paddingInline: '0.75rem',
    textDecorationLine: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':active': tokens['--xid-sidebar'],
    },
    transitionProperty: 'background-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  indexTitle: {
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
    fontWeight: 600,
    lineHeight: 1.4,
  },
  indexSummary: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    maxWidth: '36rem',
  },
  back: {
    display: 'inline-block',
    marginBottom: 'clamp(1.5rem, 2vw, 2rem)',
    color: {
      default: tokens['--xid-accent'],
      ':hover': tokens['--xid-primary'],
    },
    fontSize: '0.8125rem',
    fontWeight: 500,
    textDecorationLine: {
      default: 'none',
      ':hover': 'underline',
    },
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  // 正文小节:1px hairline 分节 + 双位 mono 序号;段落限行长,表格与代码块吃满栏宽。
  section: {
    marginTop: 'clamp(2.5rem, 3vw, 4rem)',
    paddingTop: 'clamp(1.5rem, 2vw, 2.5rem)',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    scrollMarginTop: '5.5rem',
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.875rem',
    marginBottom: 'clamp(1rem, 1.4vw, 1.5rem)',
  },
  sectionIndex: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  h2: {
    margin: 0,
    fontSize: 'clamp(1.1875rem, 1.05rem + 0.35vw, 1.5rem)',
    fontWeight: 650,
    lineHeight: 1.2,
    letterSpacing: '-0.014em',
    color: tokens['--xid-fg'],
  },
  p: {
    marginBlock: '0 0.875rem',
    maxWidth: 'clamp(42rem, 34vw, 48rem)',
    color: tokens['--xid-muted-foreground'],
    fontSize: 'clamp(0.9375rem, 0.875rem + 0.15vw, 1.0625rem)',
    lineHeight: 1.65,
  },
  ul: {
    marginBlock: '0 1rem',
    paddingInlineStart: '1.25rem',
    maxWidth: 'clamp(42rem, 34vw, 48rem)',
    color: tokens['--xid-muted-foreground'],
    fontSize: 'clamp(0.9375rem, 0.875rem + 0.15vw, 1.0625rem)',
    lineHeight: 1.65,
    display: 'grid',
    gap: '0.5rem',
  },
  pre: {
    overflowX: 'auto',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    color: tokens['--xid-fg'],
    padding: 'clamp(1rem, 1.4vw, 1.5rem)',
    marginBlock: '1rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    lineHeight: 1.6,
  },
  // 表格与 DataTable 同语言:无外框,表头 microlabel + border-strong 底线,首列文本与段落同缘。
  tableWrap: {
    overflowX: 'auto',
    marginBlock: '1rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
    fontVariantNumeric: 'tabular-nums',
  },
  th: {
    // hairline 邻接 >= 1.25rem:表头文本距底线 1.25rem,首行文本距底线 1.25rem
    paddingBlockStart: '0.875rem',
    paddingBlockEnd: '1.25rem',
    paddingInlineStart: 0,
    paddingInlineEnd: '1.5rem',
    textAlign: 'left',
    verticalAlign: 'bottom',
    backgroundColor: 'transparent',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border-strong'],
    whiteSpace: 'nowrap',
  },
  tableRow: {
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
    },
    transitionProperty: 'background-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  cell: {
    // hairline 邻接 >= 1.25rem:单元格文本与上下行线各保 1.25rem
    paddingBlock: '1.25rem',
    paddingInlineStart: 0,
    paddingInlineEnd: '1.5rem',
    textAlign: 'left',
    verticalAlign: 'top',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
    lineHeight: 1.55,
  },
  // 右侧锚点列:<=1100px 整列隐藏;吸附节奏与左目录一致。
  toc: {
    display: {
      default: 'block',
      '@media (max-width: 1100px)': 'none',
    },
    minWidth: 0,
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingInlineStart: 'clamp(1.25rem, 1.8vw, 2.25rem)',
    paddingInlineEnd: 'clamp(1.25rem, 2vw, 2.5rem)',
  },
  tocSticky: {
    position: 'sticky',
    top: '4rem',
    maxHeight: 'calc(100dvh - 4rem)',
    overflowY: 'auto',
    paddingBlock: 'clamp(2.25rem, 3vw, 4rem) 3rem',
  },
  tocLabel: {
    margin: '0 0 0.875rem',
  },
  tocList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
  },
  tocLink: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.625rem',
    paddingBlock: '0.3125rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    lineHeight: 1.45,
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
      ':active': tokens['--xid-accent'],
    },
    textDecorationLine: 'none',
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  tocLinkActive: {
    color: tokens['--xid-fg'],
    fontWeight: 600,
  },
  tocIndex: {
    flexShrink: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.625rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
})

const SIDEBAR_TOP_DOCS = DOCS.filter((doc) => !doc.slug.startsWith('sdks/'))
const SIDEBAR_SDK_DOCS = DOCS.filter((doc) => doc.slug.startsWith('sdks/'))

// 小节锚点 id 用顺序索引(标题是 Trans 内容,无稳定英文 slug 可取),正文 h2 与右侧锚点列共用。
const sectionAnchorId = (index: number): string => `section-${index + 1}`
const sectionIndexLabel = (index: number): string => String(index + 1).padStart(2, '0')

function Header(): ReactNode {
  const { t } = useLingui()
  return (
    <header {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.headerInner)}>
        <Link to="/" aria-label="XID" {...stylex.props(styles.brand)}>
          <BrandLogo height={32} />
        </Link>
        <nav {...stylex.props(styles.nav)} aria-label={t`Developer docs navigation`}>
          <Link to="/docs" {...stylex.props(styles.navLink)}>
            <Trans>Developer docs</Trans>
          </Link>
          <LanguageSwitcher />
          <PublicAuthLink {...stylex.props(styles.navLink)} />
        </nav>
      </div>
    </header>
  )
}

function SidebarLink({ doc, activeHref }: { doc: DocEntry; activeHref: string | null }): ReactNode {
  const isActive = activeHref === doc.href
  return (
    <li>
      <Link
        to={doc.href}
        aria-current={isActive ? 'page' : undefined}
        {...stylex.props(styles.sideLink, isActive && styles.sideLinkActive)}
      >
        {doc.title}
      </Link>
    </li>
  )
}

// 窄屏目录折叠到顶部:纯 UI 状态,路由切换自动收起;宽屏由媒体查询常显并吸附。
function Sidebar({ activeHref }: { activeHref: string | null }): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  const navId = useId()
  const [isNavOpen, setIsNavOpen] = useState(false)

  useEffect(() => {
    setIsNavOpen(false)
  }, [location.pathname])

  return (
    <aside {...stylex.props(styles.aside)}>
      <div {...stylex.props(styles.sideSticky)}>
        <button
          type="button"
          aria-expanded={isNavOpen}
          aria-controls={navId}
          onClick={() => setIsNavOpen((open) => !open)}
          {...stylex.props(styles.microlabel, styles.navToggle)}
        >
          <Trans>Developer docs</Trans>
          <span
            aria-hidden="true"
            {...stylex.props(styles.navChevron, isNavOpen && styles.navChevronOpen)}
          />
        </button>
        <nav
          id={navId}
          aria-label={t`XID developer documentation`}
          {...stylex.props(styles.sideNav, isNavOpen && styles.sideNavOpen)}
        >
          <SidebarGroups activeHref={activeHref} />
        </nav>
      </div>
    </aside>
  )
}

function SidebarGroups({ activeHref }: { activeHref: string | null }): ReactNode {
  return (
    <>
      <p {...stylex.props(styles.microlabel, styles.sideGroupLabel, styles.sideGroupLabelFirst)}>
        <Trans>Developer docs</Trans>
      </p>
      <ul {...stylex.props(styles.sideList)}>
        {SIDEBAR_TOP_DOCS.map((doc) => (
          <SidebarLink key={doc.slug} doc={doc} activeHref={activeHref} />
        ))}
      </ul>
      <p {...stylex.props(styles.microlabel, styles.sideGroupLabel, styles.sideGroupLabelGap)}>
        <Trans>SDK packages</Trans>
      </p>
      <ul {...stylex.props(styles.sideList)}>
        {SIDEBAR_SDK_DOCS.map((doc) => (
          <SidebarLink key={doc.slug} doc={doc} activeHref={activeHref} />
        ))}
      </ul>
    </>
  )
}

// 索引分区:microlabel 区头 + 行式条目,宽屏双列编排,行间 1px hairline,与 DataTable 同语言。
function IndexGroup({
  label,
  docs,
  spaced = false,
}: {
  label: ReactNode
  docs: readonly DocEntry[]
  spaced?: boolean
}): ReactNode {
  return (
    <div {...stylex.props(spaced && styles.indexGroupGap)}>
      <h2 {...stylex.props(styles.microlabel, styles.indexHead)}>{label}</h2>
      <ul {...stylex.props(styles.indexList)}>
        {docs.map((doc) => (
          <li key={doc.slug} {...stylex.props(styles.indexItem)}>
            <Link to={doc.href} {...stylex.props(styles.indexRow)}>
              <span {...stylex.props(styles.indexTitle)}>{doc.title}</span>
              <span {...stylex.props(styles.indexSummary)}>{doc.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DocsIndex(): ReactNode {
  const { t } = useLingui()
  return (
    <>
      <section {...stylex.props(styles.hero)}>
        <div>
          <p {...stylex.props(styles.microlabel, styles.eyebrow)}>
            <Trans>XID developer documentation</Trans>
          </p>
          <h1 {...stylex.props(styles.title)}>
            <Trans>XID Developer Docs</Trans>
          </h1>
        </div>
        <p {...stylex.props(styles.lead, styles.leadAlign)}>
          <Trans>
            Protocol, API, inbound enterprise SSO, SCIM, SDK, and self-hosting references for
            integrating with XID.
          </Trans>
        </p>
      </section>
      <section aria-label={t`Documentation sections`}>
        <IndexGroup label={<Trans>Developer docs</Trans>} docs={SIDEBAR_TOP_DOCS} />
        <IndexGroup label={<Trans>SDK packages</Trans>} docs={SIDEBAR_SDK_DOCS} spaced />
      </section>
    </>
  )
}

function DocTableView({ table }: { table: DocTable }): ReactNode {
  return (
    <div {...stylex.props(styles.tableWrap)}>
      <table {...stylex.props(styles.table)}>
        <thead>
          <tr>
            {table.headers.map((cell, index) => (
              <th key={index} scope="col" {...stylex.props(styles.microlabel, styles.th)}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} {...stylex.props(styles.tableRow)}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} {...stylex.props(styles.cell)}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocSectionView({ section, index }: { section: DocSection; index: number }): ReactNode {
  return (
    <section id={sectionAnchorId(index)} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <span aria-hidden="true" {...stylex.props(styles.sectionIndex)}>
          {sectionIndexLabel(index)}
        </span>
        <h2 {...stylex.props(styles.h2)}>{section.heading}</h2>
      </div>
      {section.body?.map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex} {...stylex.props(styles.p)}>
          {paragraph}
        </p>
      ))}
      {section.bullets ? (
        <ul {...stylex.props(styles.ul)}>
          {section.bullets.map((item, itemIndex) => (
            <li key={itemIndex}>{item}</li>
          ))}
        </ul>
      ) : null}
      {section.table ? <DocTableView table={section.table} /> : null}
      {section.code ? (
        <pre {...stylex.props(styles.pre)}>
          <code>{section.code}</code>
        </pre>
      ) : null}
    </section>
  )
}

// 滚动联动:观察各小节与视口中带的交叉,驱动右侧锚点列的当前项;不支持的环境静默退化为纯锚点。
function useActiveSectionAnchor(doc: DocEntry): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    setActiveId(null)
    if (typeof IntersectionObserver === 'undefined') return
    const targets: HTMLElement[] = []
    for (let index = 0; index < doc.sections.length; index += 1) {
      const element = document.getElementById(sectionAnchorId(index))
      if (element) targets.push(element)
    }
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const first = visible[0]
        if (first) setActiveId(first.target.id)
      },
      { rootMargin: '-30% 0px -55% 0px' },
    )
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [doc])

  return activeId
}

function TocAnchor({
  section,
  index,
  activeId,
}: {
  section: DocSection
  index: number
  activeId: string | null
}): ReactNode {
  const anchorId = sectionAnchorId(index)
  const isActive = activeId === anchorId
  return (
    <li>
      <a
        href={`#${anchorId}`}
        aria-current={isActive ? 'location' : undefined}
        {...stylex.props(styles.tocLink, isActive && styles.tocLinkActive)}
      >
        <span aria-hidden="true" {...stylex.props(styles.tocIndex)}>
          {sectionIndexLabel(index)}
        </span>
        <span>{section.heading}</span>
      </a>
    </li>
  )
}

// 右侧本页锚点列:由 DocSection heading 生成,纯锚点导航,复用既有文案不新增 msgid。
function PageToc({ doc }: { doc: DocEntry }): ReactNode {
  const { t } = useLingui()
  const activeId = useActiveSectionAnchor(doc)
  return (
    <aside {...stylex.props(styles.toc)}>
      <div {...stylex.props(styles.tocSticky)}>
        <p {...stylex.props(styles.microlabel, styles.tocLabel)}>
          <Trans>Documentation sections</Trans>
        </p>
        <nav aria-label={t`Documentation sections`}>
          <ol {...stylex.props(styles.tocList)}>
            {doc.sections.map((section, index) => (
              <TocAnchor key={index} section={section} index={index} activeId={activeId} />
            ))}
          </ol>
        </nav>
      </div>
    </aside>
  )
}

function DocDetail({ doc }: { doc: DocEntry }): ReactNode {
  return (
    <>
      <Link to="/docs" {...stylex.props(styles.back)}>
        <Trans>All developer docs</Trans>
      </Link>
      <article>
        <header {...stylex.props(styles.hero, styles.docHeader)}>
          <div>
            <p {...stylex.props(styles.microlabel, styles.eyebrow)}>
              <Trans>XID developer documentation</Trans>
            </p>
            <h1 {...stylex.props(styles.title, styles.titleDetail)}>{doc.title}</h1>
          </div>
          <p {...stylex.props(styles.lead, styles.leadAlign)}>{doc.summary}</p>
        </header>
        {doc.sections.map((section, index) => (
          <DocSectionView key={index} section={section} index={index} />
        ))}
      </article>
    </>
  )
}

function MissingDoc(): ReactNode {
  return (
    <>
      <section {...stylex.props(styles.hero)}>
        <div>
          <p {...stylex.props(styles.microlabel, styles.eyebrow)}>
            <Trans>Not found</Trans>
          </p>
          <h1 {...stylex.props(styles.title)}>
            <Trans>XID developer document not found</Trans>
          </h1>
        </div>
        <p {...stylex.props(styles.lead, styles.leadAlign)}>
          <Trans>This URL is not part of the published XID developer docs.</Trans>
        </p>
      </section>
      <Link to="/docs" {...stylex.props(styles.back)}>
        <Trans>Back to developer docs</Trans>
      </Link>
    </>
  )
}

function resolveDoc(path: string): DocEntry | null {
  const slug = resolvePublicDocSlug(path)
  return slug ? (bySlug.get(slug) ?? null) : null
}

// dev 路由诊断:一行可复制 JSON,验证公开 docs 注册表决策(生产不输出)。
function useDocsRouteDiagnostic(input: {
  path: string
  isIndex: boolean
  doc: DocEntry | null
}): void {
  const { path, isIndex, doc } = input
  const { t } = useLingui()

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const decision = getPublicDocsRouteDecision(path)
    const diagnostic = {
      ...decision,
      renderedTitle: isIndex
        ? t`XID Developer Docs`
        : doc
          ? // SDK 详情页标题是包标识(代码字面量),直接用 titleLabel,免去 24 条 t 映射。
            (doc.titleLabel ??
            {
              'getting-started': t`Getting started`,
              'hosted-auth': t`Hosted Auth`,
              'oidc-oauth': t`OIDC and OAuth`,
              'management-api': t`Management API`,
              webhooks: t`Webhooks`,
              branding: t`Branding`,
              scim: t`SCIM API reference`,
              saml: t`SAML SSO`,
              sdks: t`SDKs`,
              'self-hosting': t`Self-hosting`,
            }[doc.slug])
          : t`XID developer document not found`,
    }
    console.warn(`[xid:docs] route-decision ${JSON.stringify(diagnostic)}`)
  }, [doc, isIndex, path, t])
}

export default function DocsPage(): ReactNode {
  const location = useLocation()
  const path = normalizeDocsPath(location.pathname)
  const isIndex = path === '/docs'
  const doc = isIndex ? null : resolveDoc(path)
  useDocsRouteDiagnostic({ path, isIndex, doc })

  return (
    <div {...stylex.props(styles.root)}>
      <Header />
      <main {...stylex.props(styles.shell, doc != null && styles.shellWithToc)}>
        <Sidebar activeHref={doc?.href ?? null} />
        <div {...stylex.props(styles.content)}>
          {isIndex ? <DocsIndex /> : doc ? <DocDetail doc={doc} /> : <MissingDoc />}
        </div>
        {doc ? <PageToc doc={doc} /> : null}
      </main>
    </div>
  )
}

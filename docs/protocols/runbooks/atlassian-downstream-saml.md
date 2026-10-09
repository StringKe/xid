# Atlassian Guard downstream SAML runbook

## Console steps

1. Open **Console -> Organization -> SAML apps** and choose **Add SAML app**.
2. Pick **Atlassian Guard** under **App**. The preset sends `emailaddress`, `givenname`, and `surname` claims plus `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name` carrying the XID user ID, an immutable value that does not change when the email changes. The NameID format is `emailAddress`.
3. Import the SP metadata that Atlassian shows for the SAML configuration under **App metadata** (URL or XML), or set **Entity ID** to `https://auth.atlassian.com/saml/<connection-id>` and **Assertion consumer URL** to `https://auth.atlassian.com/login/callback?connection=saml-<connection-id>`. A value that still contains `{` or `}` returns 422.
4. From **Give these to Atlassian Guard** on the app page, copy the Issuer and Sign-in URL into the Atlassian identity provider settings and paste the signing certificate from the downloaded IdP metadata.
5. Limit **Who can sign in** if needed, then confirm the ACS POST round-trip in staging.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-protocol-client.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgOutboundSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `Atlassian Guard`; direction: `outbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:protocol-client`, then complete one downstream SaaS SAML or OIDC login from the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the downstream app assignment, test connection, and test user access, then confirm the downstream login is denied.
- BLOCKED evidence: record missing Atlassian Guard admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.

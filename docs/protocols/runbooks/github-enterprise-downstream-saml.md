# GitHub Enterprise downstream SAML runbook

## Console steps

1. Open **Console -> Organization -> SAML apps** and choose **Add SAML app**.
2. Pick **GitHub Enterprise Cloud** under **App**. The preset sets the attribute mapping (`emails`, `full_name`) and the `emailAddress` NameID format, and sets no single logout URL.
3. Set **Entity ID** to `https://github.com/enterprises/<enterprise>` and **Assertion consumer URL** to `https://github.com/enterprises/<enterprise>/saml/consume`, using the enterprise slug shown in GitHub's SAML settings. A value that still contains `{` or `}` returns 422.
4. From **Give these to GitHub Enterprise Cloud** on the app page, copy the Issuer and Sign-in URL into the GitHub enterprise SAML settings and paste the signing certificate from the downloaded IdP metadata.
5. Limit **Who can sign in** if needed, then test the SAML configuration from GitHub and confirm the ACS POST round-trip in staging.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-protocol-client.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgOutboundSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `GitHub Enterprise`; direction: `outbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:protocol-client`, then complete one downstream SaaS SAML or OIDC login from the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the downstream app assignment, test connection, and test user access, then confirm the downstream login is denied.
- BLOCKED evidence: record missing GitHub Enterprise admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.

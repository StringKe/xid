# Salesforce downstream SAML/OIDC runbook

## Console steps

1. Open **Console -> Organization -> SAML apps** and choose **Add SAML app**.
2. Pick **Salesforce** under **App**. The preset sets the attribute mapping (`email`, `firstName`, `lastName`, `displayName`) and the `emailAddress` NameID format.
3. Import the SP metadata that Salesforce publishes for the SAML single sign-on setting under **App metadata** (URL or XML), or set **Entity ID** and **Assertion consumer URL** to `https://<my-domain>.my.salesforce.com`. A value that still contains `{` or `}` returns 422.
4. From **Give these to Salesforce** on the app page, copy the Issuer and Sign-in URL into the Salesforce SAML single sign-on setting and upload the signing certificate from the downloaded IdP metadata.
5. For OIDC sign-in, register the app as an XID application through `/v1/applications` with the exact redirect URI `https://<my-domain>.my.salesforce.com/services/authcallback/<auth-provider>`. The SAML app form does not register OIDC clients.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-protocol-client.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgOutboundSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `Salesforce`; direction: `outbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:protocol-client`, then complete one downstream SaaS SAML or OIDC login from the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the downstream app assignment, test connection, and test user access, then confirm the downstream login is denied.
- BLOCKED evidence: record missing Salesforce admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.

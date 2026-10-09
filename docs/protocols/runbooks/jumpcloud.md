# JumpCloud inbound SAML runbook

## Console steps

1. Open **Console -> Organization -> Enterprise SSO** and choose **Add connection**.
2. Pick **JumpCloud** and **SAML 2.0**. The preset sets the attribute mapping (`email`, `firstname`, `lastname`) and JIT, and requires a signed Assertion.
3. Export the IdP metadata file of the JumpCloud SSO application and upload it in **Metadata XML**. JumpCloud offers the metadata as a file export, so the preset has no metadata URL. XID parses the XML when the connection is saved and fills Entity ID, sign-in URL, and signing certificates; XML that is not IdP metadata returns 422 on `idp_metadata_xml`.
4. Copy the **ACS URL** and **Entity ID** shown in the wizard into the JumpCloud SSO application, or give JumpCloud the SP metadata from `/sso/saml/{connectionId}/metadata`.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-inbound-saml.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `JumpCloud`; direction: `inbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:inbound-saml`, then complete one signed IdP initiated or SP initiated SAML callback in the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the test SSO connection, IdP app assignment, and test user access, then confirm the callback no longer authorizes.
- BLOCKED evidence: record missing JumpCloud admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.

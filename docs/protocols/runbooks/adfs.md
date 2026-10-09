# AD FS inbound SAML runbook

## Console steps

1. Open **Console -> Organization -> Enterprise SSO** and choose **Add connection**.
2. Pick **AD FS** and **SAML 2.0**. The preset maps the `emailaddress`, `givenname`, and `surname` claims, enables JIT, and requires a signed Assertion (AD FS signs the Assertion by default).
3. Enter the AD FS federation metadata URL, in the form `https://<adfs-host>/FederationMetadata/2007-06/FederationMetadata.xml`. XID fetches and parses it when the connection is saved and fills Entity ID, sign-in URL, and signing certificates. A fetch or parse failure returns 422 on `idp_metadata_url`, and a value that still contains `{` or `}` is rejected.
4. Create the AD FS relying party trust from the SP metadata at `/sso/saml/{connectionId}/metadata`, or enter the **ACS URL** and **Entity ID** shown in the wizard.

## Local L3 evidence

- Smoke harness: `apps/server/tests/smoke/l3-inbound-saml.test.mjs`
- Preset source: `apps/server/worker/sso/provider-presets.ts`
- Console: `apps/console/src/routes/org/OrgSso.tsx`

## Production L4 blocked inputs

- Real admin access, live metadata, signed callback round-trip, and provider-specific assignment gates are still required before production-supported claims.

## L4 production evidence

- Provider: `AD FS`; direction: `inbound`.
- Current HEAD: run `git rev-parse HEAD` and record the complete commit.
- Active Worker version: run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the `version_id` at 100 percent.
- Smoke: run `pnpm --filter @xid-kit/server smoke:l3:inbound-saml`, then complete one signed IdP initiated or SP initiated SAML callback in the production test tenant.
- Transaction evidence: record UTC timestamp, de-identified tenant_id, de-identified connection_id, provider transaction id or assertion/request id, expected result, and actual result.
- Cleanup: remove the test SSO connection, IdP app assignment, and test user access, then confirm the callback no longer authorizes.
- BLOCKED evidence: record missing AD FS admin access, isolated test tenant, callback domain, test user, assignment, or signing material. Do not record secrets, complete assertions, or personal data.

# Protocol runbooks

Operator runbooks for enterprise IdP inbound SSO and downstream SaaS outbound SSO presets.

| Runbook                                                                            | Preset key                 | Direction |
| ---------------------------------------------------------------------------------- | -------------------------- | --------- |
| [okta.md](./okta.md)                                                               | `okta`                     | inbound   |
| [microsoft-entra-id.md](./microsoft-entra-id.md)                                   | `microsoft-entra`          | inbound   |
| [google-workspace.md](./google-workspace.md)                                       | `google-workspace`         | inbound   |
| [onelogin.md](./onelogin.md)                                                       | `onelogin`                 | inbound   |
| [jumpcloud.md](./jumpcloud.md)                                                     | `jumpcloud`                | inbound   |
| [pingone.md](./pingone.md)                                                         | `pingone`                  | inbound   |
| [pingfederate.md](./pingfederate.md)                                               | `pingfederate`             | inbound   |
| [adfs.md](./adfs.md)                                                               | `adfs`                     | inbound   |
| [shibboleth.md](./shibboleth.md)                                                   | `shibboleth`               | inbound   |
| [keycloak.md](./keycloak.md)                                                       | `keycloak`                 | inbound   |
| [slack-downstream-saml.md](./slack-downstream-saml.md)                             | `slack`                    | outbound  |
| [github-enterprise-downstream-saml.md](./github-enterprise-downstream-saml.md)     | `github-enterprise`        | outbound  |
| [microsoft-enterprise-app-downstream.md](./microsoft-enterprise-app-downstream.md) | `microsoft-enterprise-app` | outbound  |
| [atlassian-downstream-saml.md](./atlassian-downstream-saml.md)                     | `atlassian`                | outbound  |
| [salesforce-downstream-saml-oidc.md](./salesforce-downstream-saml-oidc.md)         | `salesforce`               | outbound  |
| [zoom-downstream-saml-oidc.md](./zoom-downstream-saml-oidc.md)                     | `zoom`                     | outbound  |

## L4 production evidence contract

The L4 record of every provider runbook MUST contain the fields below. A missing field means BLOCKED, and the runbook MUST NOT be marked production-supported.

| Field                 | Requirement                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current HEAD          | Run `git rev-parse HEAD` and record the full commit.                                                                                                                                                          |
| Active Worker version | Run `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json` and record the 100 percent active version_id.                                                                          |
| Readiness gate        | Run `pnpm run goal:readiness` and keep the PASS output for the current HEAD.                                                                                                                                  |
| Provider smoke        | Run the local smoke named by that runbook first, then complete one controlled transaction against the real provider.                                                                                          |
| Transaction           | Record the UTC timestamp, redacted tenant_id, redacted connection_id, provider transaction_id or assertion/request id, and the expected and actual results.                                                   |
| Cleanup               | Delete the test connection, test app assignment, test user, or test group, then read back to confirm sign-in is no longer possible.                                                                           |
| BLOCKED               | Record the missing provider admin, test tenant, callback domain, test user, certificate, or authorization input. Secrets, tokens, full assertions, and personal data MUST NOT be written into the repository. |

The final verdict for every provider L4 is gated on `pnpm run goal:readiness`. The local smoke in a runbook only proves L3 and MUST NOT replace a real provider transaction.

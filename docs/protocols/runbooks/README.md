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

每个 provider runbook 的 L4 记录必须包含以下字段，缺少任一字段即为 BLOCKED，不得标记 production-supported。

| 字段                  | 要求                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Current HEAD          | 执行 `git rev-parse HEAD` 并记录完整 commit。                                                                                   |
| Active Worker version | 执行 `pnpm --filter @xid-kit/server exec wrangler deployments status --name xid --json`，记录 100 percent active version_id。   |
| Readiness gate        | 执行 `pnpm run goal:readiness`，保留当前 HEAD 的 PASS 输出。                                                                    |
| Provider smoke        | 先执行该 runbook 指定的本地 smoke，再使用真实 provider 完成一次受控 transaction。                                               |
| Transaction           | 记录 UTC timestamp、脱敏 tenant_id、脱敏 connection_id、provider transaction_id 或 assertion/request id、预期和实际结果。       |
| Cleanup               | 删除测试 connection、测试 app assignment、测试 user 或 test group，并回读确认无法再次登录。                                     |
| BLOCKED               | 记录缺失的 provider admin、测试 tenant、回调域、测试 user、证书或授权输入。密钥、token、完整 assertion 和个人数据不得写入仓库。 |

所有 provider L4 的最终判定以 `pnpm run goal:readiness` 为 gate。runbook 中的本地 smoke 只证明 L3，不能替代真实 provider transaction。

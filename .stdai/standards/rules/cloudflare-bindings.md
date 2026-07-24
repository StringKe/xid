---
type: rules
name: cloudflare-bindings
description: Cloudflare 服务绑定用途与边界:D1/DO 强一致/KV 缓存/R2 对象/Queues 异步/Secrets/Analytics Engine
priority: high
applyTo:
  - 'apps/server/worker/**/*.ts'
  - 'wrangler.toml'
  - 'wrangler.jsonc'
  - '**/durable-objects/**/*.ts'
targets: [claude-code, codex]
---

# Cloudflare 服务映射与使用边界

每种存储/服务有明确职责,选错=正确性或性能问题。详见 `docs/design/00-overview.md` 第 8 节。

## 服务映射

| 服务                            | 用途                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Workers + Hono                  | HTTP / 协议处理                                                                          |
| D1                              | 用户/应用/组/凭证元数据/授权码/refresh token/审计/租户/密钥密文/会话                     |
| Durable Objects                 | WebAuthn challenge、OAuth state/nonce/PKCE、会话撤销集、按租户限流(强一致防重放)         |
| KV                              | JWKS / discovery / 品牌配置 / feature flag 缓存                                          |
| R2                              | 头像、logo、邮件语言包、数据导出文件、GeoIP MMDB                                         |
| Queues                          | 邮件、审计异步落库、webhook 投递(重试/死信)、计量事件                                    |
| Email Sending(send_email)       | Cloudflare Email Service 出站事务邮件(验证/magic link/OTP/重置/告警),发任意外部地址      |
| Cron Triggers                   | 过期清理、密钥轮换、custom hostname 证书状态轮询、DAU/MAU 聚合、状态页探活、域名验证轮询 |
| Workers Secrets                 | KEK 主密钥、pepper、provider 凭证                                                        |
| Turnstile / WAF / Rate Limiting | 防滥用                                                                                   |
| Analytics Engine                | 实时指标(登录成功率/MFA 采用率/活跃数)                                                   |

## 选型铁律

- **强一致 / 防重放 / 串行**用 Durable Objects:challenge、OAuth state/nonce/PKCE、会话撤销集、按租户限流。短期强一致数据不进 D1 关系表。
- **缓存读多写少**用 KV:JWKS(TTL 1h)、discovery、品牌配置(`brand:{tenant_id}` / `brand:{tenant_id}:{org_id}`,P50<2ms)、feature flag(`flag:{tenant_id}:{flag_name}`,全局默认 `flag:global:{flag_name}`,直读 <1ms)。
- **异步不阻塞主链路**用 Queues:邮件 / 审计落库 / webhook / 计量,登录链路绝不同步等这些。审计写路径经 Queues,保证登录 P99<200ms。
- **大对象**用 R2:头像、logo、语言包、导出文件、GeoIP MMDB(Login Worker 启动预加载到内存,impossible travel 计算 <5ms)。

## 会话存储方案(05 章 8)

- D1:`sessions` 表持久化(refresh token hash/device/status/expires_at)。
- Durable Object(per-user):持有该用户所有 active session_id set,撤销先更新 DO 内存再异步落 D1,DO 保证单 user session 操作串行避免竞态,JWT 60s 窗口内生效。
- KV:缓存 JWKS 公钥 TTL 1h,验证 JWT 直接读 KV 不回源。

## 审计链(07 章 5)

审计仅 INSERT 无 UPDATE/DELETE;单调递增 seq + 前条 SHA256 链式 hash 存 prev_hash,构成 append-only 链;Consumer 批量写(批 100),链式 hash 在 Consumer 侧单线程算保证顺序。

## 邮件发送(07 章 3.1)

- 邮件发送默认走 **Cloudflare Email Service**(send_email binding,名 `EMAIL`):`env.EMAIL.send({to, from:{email,name}, subject, html, text})`,无需 API key,可发任意外部收件地址。
- 发件域必须 onboard(`wrangler email sending enable {domain}`)+ DKIM/SPF/DMARC;仅 transactional;`html`+`text` 双版本必填。
- provider 抽象成 `EmailProvider` 接口,`CloudflareEmailProvider` 为默认实现,Resend/SendGrid/SMTP 同接口可选。EmailConsumer 经此接口发信,不裸调具体 provider。

## 通知与计量(07 章 3、7)

- 通知经 Queues 异步,`queue.send({type, recipient, payload})`,Consumer 渲染模板后经 `EmailProvider` 发信,失败指数退避重试最多 5 次,死信入 D1 `notification_failures`。
- 计量:Login Worker 认证成功后向 Queues 写 `{tenant_id, user_id, ts}`;Metering Consumer 去重按天写 D1 `usage_daily`;Cron 每小时聚合当月 MAU。MAU 去重走 MeteringDO(按租户分片,DO storage per-user membership 键 `member:month:{ym}:{userId}` 精确去重),**不用 HyperLogLog**(0.8% 误差不可接受);`metering_user_index` 是 Roaring Bitmap 旧设计残留表,无读写。

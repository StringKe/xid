---
type: rules
name: anti-abuse
description: 三层防滥用(Rate Limiting/Turnstile/DO)+ 登录限流阈值表 + 账户枚举防护 constant-time
priority: normal
applyTo:
  - 'apps/server/worker/**/auth/**/*.ts'
  - 'apps/server/worker/**/middleware/**/*.ts'
targets: [claude-code, codex]
---

# 防滥用、限流、枚举防护

详见 `docs/design/01-authentication.md` 第 7 节、`docs/design/07-platform-operations.md` 第 6 节。

## 三层防滥用

Rate Limiting(网络)+ Turnstile(表单)+ Durable Object(业务)。

Bot 防护介入点:

- 登录页加载:Turnstile invisible challenge。
- 注册:Turnstile + 可选 email 验证。
- 密码重置请求:Turnstile 防刷。
- OTP 发送接口:独立速率限制。

## 登录限流阈值

| 维度       | 阈值                 | 锁定       |
| ---------- | -------------------- | ---------- |
| 账户级失败 | 10 次 / 15 分钟      | 指数退避   |
| IP 级失败  | 50 次 / 分钟         | 1 小时     |
| OTP 发送   | 1 次 / 分钟 / 接收方 | 429,不报错 |

计数器存 KV(TTL 自动过期),Worker 层拦截。账户锁定指数退避:5/15/30/60min,`lockout_until` 存 users。

## 账户枚举防护(铁律)

- 所有认证接口统一返回模糊响应,**不区分**"用户不存在"与"密码错误"。
- 响应时间归一化(constant-time + 固定 timing jitter)。
- 注册时 email 已存在 -> 发"已有账户"提醒邮件,接口仍返回 200。
- 重置邮件不区分"邮箱不存在"与"已发送"。
- 社交登录不依 provider_user_id 存在与否返回不同响应。
- Conditional UI 不泄露凭证是否存在(结果为空不报错)。

## 异常检测(07 章 6)

- 暴力破解:同 IP 5min 内 10 次失败 -> CAPTCHA / 临时封禁(KV TTL 15min)。
- impossible travel:IP 归属地偏差 >1000km 且时间差 <2h -> 告警。在 Login Worker 同步计算(GeoIP MMDB 存 R2 启动预加载,<5ms),触发告警走异步 Queue。
- 设备指纹突变 -> 新设备告警邮件。

## 设备信任(01 章 7)

- 登录成功颁发设备 token(签名 cookie,30 天),校验通过可跳过或降级 MFA(可配置)。
- 设备指纹:UA + IP 段 + Accept-Language + TLS fingerprint,不依赖单一信号。
- 用户可在安全设置查看并撤销信任设备。

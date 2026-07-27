# Firebase 式访客模式(匿名注册 -> 原地转正)落地计划

## 基线

- 日期:2026-07-26
- 目标:guest 是真 user 行(provisioned_by = 'anonymous'),无已链接凭证即为 guest;转正原地 link,sub 不变
- 设计共识(用户已拍板):
  - GC 按最后活跃满 30 天
  - email 冲突先验证后告知,引导登录既有账号,数据合并由 RP 应用层负责
  - SDK 覆盖 React + sdk/ 全部原生平台
  - 不做 OAuth extension grant、不做 XID 托管合并端点、不做 Cognito 式非 user 凭证

## 冻结范围

- 新端点 POST /auth/guest,四层防重复:SDK 惰性复用 -> 端点先查后建幂等续签 -> GuestStore DO 按 anonKey 并发去重 -> Turnstile + RateLimitStore + 每租户日上限 + GC 兜底
- 转正 = 持 guest session 完成首个凭证仪式(passkey / 密码 / email OTP / social)即原地 link;转正成功轮换 session
- token amr 按凭证存在性推导('guest'),不写新 status 枚举、不加 session 类型
- MeteringDO MAU 排除 guest;审计事件 guest.created / guest.converted / guest.gc_deleted
- UI 走 frontend-design / ui-polish 规范;文案全部走 lingui,React SDK 用 sdk.* runtime descriptor
- 禁止 git commit / push;禁止新增第三方依赖;禁止削弱既有安全规则

## Todo List

- [x] T1 设计文档批:docs/design/01、05、06、08 更新 guest 设计;docs/protocols/source-map.md 登记私有扩展;docs/sdks/platform-matrix.md 更新;zh-Hans 译文同步
- [x] T2 Worker 批:POST /auth/guest(四层幂等)+ GuestStore DO + wrangler/env 类型 + GC cron + 审计事件 + 计量排除 + Management API provisioned_by 过滤
- [x] T3 转正路由:me-auth 四仪式识别 guest session 原地 link + 转正 session 轮换 + email 冲突先验证后告知 + /v1/me 暴露 provisioned_by
- [x] T4 测试批:建号幂等(串行 + 并发)、转正四路径、email 冲突、session 轮换、GC cron、跨租户隔离、amr 推导
- [x] T5 Hosted UI:访客入口(SignInGuestButton)与转正引导(GuestConversionBanner)
- [x] T6 React SDK:signInAnonymously / isAnonymous / GuestUpgradeBanner + i18n descriptor;core 加 isGuestUser/isGuestToken/isSameUser
- [x] T7 原生 SDK:6 客户端(ios/macos/android/flutter/windows/linux)signInAnonymously + 7 后端(go/python/ruby/php/rust/java/dotnet)guest 判定,各平台本地测试全绿
- [x] T1 收尾:文档状态 planned -> 已实现(source-map / platform-matrix / 08 DO 清单 / 01 章标注,zh-Hans 同步,门禁全绿)
- [x] T8 总校验:pnpm run check + pnpm test 全绿

## 状态

已完成。

## 完成定义

- `pnpm run check` 全绿(typecheck、native:verify、i18n:audit、protocols:source-map、docs:translations、coverage gates)
- `pnpm test` 全绿
- T4 列出的新能力测试全部存在且通过
- T1 列出的文档全部更新且 docs:translations 通过

## 停止规则

- 设计与安全铁律冲突、必须新增第三方依赖、某原生 SDK 不破坏既有契约无法加入匿名 API、或 check 失败根因不明时,停止并汇报,不做猜测性修复。

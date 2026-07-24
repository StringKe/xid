# XID

身份认证平台,跑在 Cloudflare 全球边缘。一份代码同时做 OIDC/OAuth IdP、多租户 RBAC、企业 SSO 联邦、passkey 认证。MIT 开源(版权人 StringKe,2026),自托管即完整能力,托管版 xid.dev 提供托管运维。

## register

混合项目,按 surface 判断:

- **brand**: 官网 landing(根地址 xid.dev)、营销页、文档站。设计即产品。
- **product**: Hosted UI(登录/注册/consent/account)、管理 console。设计服务产品。

## Product Purpose

把"身份"这件每个产品都要重做一遍的脏活,变成一行 SDK + 一个边缘 Worker。对标三家的合体:Clerk 的开发者体验(DX 业界标杆)、Auth0/Zitadel 的协议完整度(OpenID Certified 级 OIDC/OAuth)、WorkOS 的企业联邦(SAML/SCIM/目录同步)。差异化卖点是**边缘原生**:不是又一个跑在某个 region 的 SaaS,而是签名、验证、会话撤销都在离用户最近的 Cloudflare 节点完成,冷启动 networkless JWT 验证。

## Users

- **应用开发者**(主):要在自己的 React/Next 应用里几分钟接好登录 + 组织管理 + passkey。看重 DX、文档、SDK 质量、Edge 性能。从官网进来第一眼要判断"这个能不能比我自己搭 Auth 省事"。
- **企业 IT / 平台方**:要 SAML/OIDC SSO、SCIM 目录同步、租户隔离、审计合规。看重协议正确性、安全边界、自托管能力。
- **终端用户**:在 Hosted UI 登录。要快、不闪、passkey 一键、看得懂的错误。

## Brand & Tone

技术上自信但不喧哗。这是给工程师看的产品:精确、克制、有密度,而不是又一张充满圆角插画和渐变光斑的 SaaS 营销页。语气像一份写得好的 RFC 或一个你信任的底层库的 README,不是销售话术。强调"边缘""协议""零信任代销商""networkless"这些真实技术概念,用代码示例而不是形容词证明能力。

## Anti-references

明确要避开的视觉/语气陷阱(category-reflex):

- **SaaS-cream**:米白背景 + 紫色渐变按钮 + 等大卡片网格 + 英雄数字模板。Clerk/Auth0 官网那一类,一眼"又一个身份 SaaS"。
- **安全产品的 navy + 盾牌 + 锁图标**反射。XID 的安全感来自精确和密度,不是堆安全 icon。
- **crypto neon-on-black**。"边缘/分布式"不等于赛博朋克霓虹。
- **AI slop**:能被一眼认出"AI 生成"的等大卡片 + icon + 标题 + 三行说明无限重复。

正面参照气质:底层基础设施工具(Cloudflare 自家文档的密度、Stripe 早期的工程克制、终端原生的精确),编辑排版优先于装饰。

## Strategic Principles

- **代码即证明**:开发者向产品,landing 必须有真实可读的集成代码(SDK 调用、OIDC 流程),而不是只有 marketing copy。
- **协议正确性零妥协**:产品层面 PKCE S256/refresh rotation/四验证 无跳过;视觉层面也不能为好看牺牲清晰(错误状态、枚举防护的模糊响应要如实呈现)。
- **不闪不抖**:Hosted UI 是登录关键路径,初始渲染必须稳定。能力检测类 UI(passkey Conditional UI、Turnstile invisible、登录方式切换)在 mount 初始保持确定骨架,探测完成后渐进揭示,绝不 layout shift。
- **边缘速度可感知**:轻、快、即时。重资源、大 bundle、阻塞首屏的东西都与定位矛盾。

## Existing system

React 19 + @tanstack/react-router(code-based SPA,`lib/router.tsx` 兼容 react-router API)+ lingui i18n(8 locale)。已有主题系统:CSS 变量 `--xid-*`(primary/bg/accent/radius/font),支持 per-tenant/org 品牌覆盖 + light/dark(prefers-color-scheme)。基础组件在 src/components/ui(Button/Input/Field/Card/Alert/Spinner/Table)。

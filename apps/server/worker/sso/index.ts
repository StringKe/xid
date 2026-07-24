// 企业 SSO 路由桶导出。各 register* 把 SP/RP/HRD 路由挂到 /sso 前缀,供 wire 阶段(routes.ts)挂载。
// SAML SP(ACS/metadata/login)+ OIDC RP(authorize/callback)+ HRD(home realm discovery,见 04 章 1/3/8)。

export { registerSamlRoutes } from './saml'
export { registerOidcRpRoutes } from './oidc-rp'
export { registerHrdRoutes } from './hrd'
export { registerOutboundSamlRoutes } from './outbound-saml'
export { registerLdapRoutes } from './ldap'
export { registerWsfedRoutes } from './wsfed'
export { registerSwaRoutes } from './swa'
export { registerDirectoryConnectorRoutes } from './directory-connector'

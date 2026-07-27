// 页面级 SEO 文案(lingui msg)。RoutePageSeo 按路由解析后经 i18n._() 写入 document.title 与 meta。

import { msg } from '@lingui/core/macro'

export const seoNotFoundTitle = msg`Page not found | XID`

export const seoSignInTitle = msg`Sign in | XID`
export const seoSignUpTitle = msg`Sign up | XID`
export const seoForgotPasswordTitle = msg`Reset password | XID`
export const seoMfaTitle = msg`Two-factor authentication | XID`
export const seoVerifyEmailTitle = msg`Verify email | XID`
export const seoAcceptInvitationTitle = msg`Accept invitation | XID`
export const seoCreateOrganizationTitle = msg`Create organization | XID`
export const seoSelectOrganizationTitle = msg`Select organization | XID`
export const seoConsentTitle = msg`Authorize application | XID`
export const seoActivateDeviceTitle = msg`Activate device | XID`
export const seoCibaActivationTitle = msg`Approve sign-in request | XID`

export const seoAccountProfileTitle = msg`Profile | Account | XID`
export const seoAccountSecurityTitle = msg`Security | Account | XID`
export const seoAccountConnectionsTitle = msg`Connections | Account | XID`
export const seoAccountSessionsTitle = msg`Sessions | Account | XID`
export const seoAccountDevicesTitle = msg`Trusted devices | Account | XID`

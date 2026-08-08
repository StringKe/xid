// session-auth(me-auth)路由注册:把本子域全部端点挂到 protocol sub-app(经 tenant + session 中间件)。
// 全部按 cookie session 认证(readSession / requireSession),不是 sk_live Bearer。
// wire 阶段统一调用 registerSessionAuthRoutes(app);本模块不碰 routes.ts / index.ts。

import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { handlePasswordSignIn } from './password-signin'
import { handleSignOut } from './signout'
import { handlePasskeyChallenge, handlePasskeyVerify } from './passkey-signin'
import { handleForgotPassword, handleResetPassword } from './password-reset'
import { handleResendVerification, handleVerifyEmail } from './email-verification'
import {
  handleMagicLinkSend,
  handleMagicLinkVerify,
  handleOtpEmailSend,
  handleOtpEmailVerify,
  handleOtpSmsSend,
  handleOtpSmsVerify,
  handleOtpWhatsappSend,
  handleOtpWhatsappVerify,
} from './passwordless'
import { handleMfaSmsSend, handleMfaVerify } from './mfa-challenge'
import { handlePasskeyMfaOptions, handlePasskeyMfaVerify } from './passkey-mfa-challenge'
import { handleConsent, handleConsentParams } from './consent'
import { handleDeviceActivation, handleDeviceActivationParams } from './device-activation'
import { handleCibaActivation, handleCibaActivationParams } from './ciba-activation'
import { handleSessionToken } from './session-token'
import { handleActiveSession } from './active-session'
import { handleActiveOrganization } from './active-organization'
import { handleInvitationAccept, handleInvitationPreview } from './invitation-accept'
import { handleInvitationClaimStart, handleInvitationClaimVerify } from './invitation-claim'
import { handleSelfOrganizationCreate } from './organization-self'
import { handleGuestSignIn } from './guest'
import {
  handleAccessApprovalApprove,
  handleAccessApprovalDeny,
  handleAccessApprovalList,
  handleAccessRequestCancel,
  handleAccessRequestCreate,
  handleAccessRequestListMine,
} from './access-requests'

export function registerSessionAuthRoutes(app: Hono<XidHonoEnv>): void {
  // 密码统一登录和创建 / 登出
  app.post('/auth/password/sign-in', handlePasswordSignIn)
  app.post('/auth/sign-out', handleSignOut)

  // guest(匿名访客)登录:先查后建 + GuestStore 并发去重
  app.post('/auth/guest', handleGuestSignIn)

  // passkey(发现式登录:challenge handle 走响应体 sessionId)
  app.post('/auth/passkey/challenge', handlePasskeyChallenge)
  app.post('/auth/passkey/verify', handlePasskeyVerify)

  // 密码重置 / 邮箱验证
  app.post('/auth/forgot-password', handleForgotPassword)
  app.post('/auth/reset-password', handleResetPassword)
  app.post('/auth/verify-email', handleVerifyEmail)
  app.post('/auth/resend-verification', handleResendVerification)

  // passwordless(magic link + 渠道拆分 OTP)
  app.post('/auth/magic-link/send', handleMagicLinkSend)
  app.get('/auth/magic-link/verify', handleMagicLinkVerify)
  app.post('/auth/otp/email/send', handleOtpEmailSend)
  app.post('/auth/otp/email/verify', handleOtpEmailVerify)
  app.post('/auth/otp/whatsapp/send', handleOtpWhatsappSend)
  app.post('/auth/otp/whatsapp/verify', handleOtpWhatsappVerify)
  app.post('/auth/otp/sms/send', handleOtpSmsSend)
  app.post('/auth/otp/sms/verify', handleOtpSmsVerify)

  // MFA(须已登录待 MFA)
  app.post('/auth/mfa/sms/send', handleMfaSmsSend)
  app.post('/auth/mfa/passkey/options', handlePasskeyMfaOptions)
  app.post('/auth/mfa/passkey/verify', handlePasskeyMfaVerify)
  app.post('/auth/mfa/verify', handleMfaVerify)

  // OIDC consent(prompt_id == authz_request_id)
  app.get('/auth/consent-params', handleConsentParams)
  app.post('/auth/consent', handleConsent)

  // OAuth Device Flow activation(user_code)
  app.get('/auth/device-activation', handleDeviceActivationParams)
  app.post('/auth/device-activation', handleDeviceActivation)

  // CIBA backchannel user approval(auth_req_id)
  app.get('/auth/ciba-activation', handleCibaActivationParams)
  app.post('/auth/ciba-activation', handleCibaActivation)

  // 组织邀请 / 自助建 org
  app.get('/auth/invitation/preview', handleInvitationPreview)
  app.post('/auth/invitation/claim', handleInvitationClaimStart)
  app.post('/auth/invitation/claim/verify', handleInvitationClaimVerify)
  app.post('/auth/invitation/accept', handleInvitationAccept)
  app.post('/v1/organizations/self', handleSelfOrganizationCreate)

  // short-lived session token(cookie 认证,非 sk_live)
  app.post('/v1/sessions/token', handleSessionToken)
  app.post('/v1/sessions/active', handleActiveSession)
  app.post('/v1/sessions/active-organization', handleActiveOrganization)

  // Project 访问申请(自助)+ 审批(design-access-request 3.1/3.2)
  app.post('/auth/access-requests', handleAccessRequestCreate)
  app.get('/auth/access-requests', handleAccessRequestListMine)
  app.post('/auth/access-requests/:id/cancel', handleAccessRequestCancel)
  app.get('/auth/access-approvals', handleAccessApprovalList)
  app.post('/auth/access-approvals/:id/approve', handleAccessApprovalApprove)
  app.post('/auth/access-approvals/:id/deny', handleAccessApprovalDeny)
}

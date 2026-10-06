// 登录结果审计 action:成功由会话签发/激活写入,失败由凭据错误统一写入;平台与组织概览按同一组名称统计。

export const AUTH_LOGIN_SUCCEEDED_EVENT = 'auth.login_succeeded'
export const AUTH_LOGIN_FAILED_EVENT = 'auth.login_failed'

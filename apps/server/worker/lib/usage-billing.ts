// 按用量(MAU)计费的唯一开关。XID 没有套餐;计费关闭时所有功能照常可用。
import { AppError } from './errors'

const STRIPE_METER_EVENT_NAME_MAX_LENGTH = 100

export type UsageBillingConfiguration = {
  secretKey: string
  webhookSecret: string
  meterEventName: string
}

function configuredValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

// 三项是一组原子配置:全配置=开启,全不配置=关闭。只配一部分时无法对账或上报,
// 不能静默降级为关闭,所以抛 server_error。
export function usageBillingConfiguration(env: Env): UsageBillingConfiguration | null {
  const secretKey = configuredValue(env.STRIPE_SECRET_KEY)
  const webhookSecret = configuredValue(env.STRIPE_WEBHOOK_SECRET)
  const meterEventName = configuredValue(env.STRIPE_METER_EVENT_NAME)
  if (!secretKey && !webhookSecret && !meterEventName) return null
  if (!secretKey || !webhookSecret || !meterEventName) {
    throw new AppError('server_error', { logReason: 'usage_billing_partially_configured' })
  }
  if (meterEventName.length > STRIPE_METER_EVENT_NAME_MAX_LENGTH) {
    throw new AppError('server_error', { logReason: 'usage_billing_meter_name_invalid' })
  }
  return { secretKey, webhookSecret, meterEventName }
}

export function billingEnabled(env: Env): boolean {
  return usageBillingConfiguration(env) !== null
}

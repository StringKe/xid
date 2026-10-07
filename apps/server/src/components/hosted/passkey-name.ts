import { useLingui } from '@lingui/react/macro'
import { detectDeviceParts } from '../../routes/account/device-label'

// 新 passkey 的默认名称:「Chrome on macOS」,识别不出时用通用名。
export function useDefaultPasskeyName(): string {
  const { t } = useLingui()
  const parts = detectDeviceParts()
  if (!parts) return t`This device`
  const { browser, platform } = parts
  return t`${browser} on ${platform}`
}

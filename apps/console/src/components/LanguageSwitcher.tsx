import type { ReactNode } from 'react'
import { LanguageSwitcher as SharedLanguageSwitcher } from '@xid-kit/web-ui/LanguageSwitcher'
import { trackLocaleChange } from '../lib/google-analytics-funnel'

export function LanguageSwitcher(): ReactNode {
  return <SharedLanguageSwitcher onLocaleChange={trackLocaleChange} />
}

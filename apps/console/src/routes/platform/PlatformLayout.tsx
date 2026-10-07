import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ConsoleLayout } from '../../components/layout/ConsoleLayout'
import { platformNav } from '../../nav'
import { useBillingConfigQuery } from './queries'

export function PlatformLayout({ children }: { children: ReactNode }): ReactNode {
  const isBillingEnabled = useBillingConfigQuery().data?.enabled === true
  const navItems = useMemo(() => platformNav({ isBillingEnabled }), [isBillingEnabled])
  return <ConsoleLayout navItems={navItems}>{children}</ConsoleLayout>
}

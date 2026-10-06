import { useSearch } from '@tanstack/react-router'
import { safeInternalPath } from '@xid-kit/web-ui/safe-redirect'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { useNavigate } from '../../lib/router'

// MFA 完成后续跑原流程;/authorize 等 Worker 路径由导航适配器走整页跳转。
export function useMfaResume(): () => void {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { redirect_to?: string }
  const defaultLandingPath = useDefaultLandingPath()
  return () => navigate(safeInternalPath(search.redirect_to, defaultLandingPath), { replace: true })
}

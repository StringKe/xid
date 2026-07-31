// @xid-kit/react:React SDK 组件库 + hooks(对标 @clerk/clerk-react)。
// 文案走 lingui runtime descriptor;appearance prop 支持主题变量覆盖;a11y 达标。
// 依赖 @xid-kit/core(XidClient/store);peerDep react 19。
// 见 docs/design/06-developer-experience.md、api-sdk-conventions rule、i18n-lingui rule。

// --- Provider ---
export { XidProvider } from './context/xid-provider'
export type { XidProviderProps } from './context/xid-provider'

export { useXidContext } from './context/xid-context'
export type { XidContextValue } from './context/xid-context'

// --- Hooks ---
export { useAuth } from './hooks/use-auth'
export type { UseAuthReturn } from './hooks/use-auth'

export { useUser } from './hooks/use-user'
export type { UseUserReturn } from './hooks/use-user'

export { useSession } from './hooks/use-session'
export type { UseSessionReturn } from './hooks/use-session'

export { useSessionList } from './hooks/use-session-list'
export type { UseSessionListReturn } from './hooks/use-session-list'

export { useSignIn } from './hooks/use-sign-in'
export type { UseSignInReturn } from './hooks/use-sign-in'

export { useOrganization } from './hooks/use-organization'
export type { UseOrganizationReturn } from './hooks/use-organization'

export { useOrganizationList } from './hooks/use-organization-list'
export type { UseOrganizationListReturn } from './hooks/use-organization-list'

export { useAPIKeys } from './hooks/use-api-keys'
export type { UseAPIKeysReturn } from './hooks/use-api-keys'

// --- Control components ---
export { SignedIn } from './components/control/signed-in'
export type { SignedInProps } from './components/control/signed-in'

export { SignedOut } from './components/control/signed-out'
export type { SignedOutProps } from './components/control/signed-out'

export { Protect } from './components/control/protect'
export type { ProtectProps } from './components/control/protect'

export { XidLoaded } from './components/control/xid-loaded'
export type { XidLoadedProps } from './components/control/xid-loaded'

export { XidLoading } from './components/control/xid-loading'
export type { XidLoadingProps } from './components/control/xid-loading'

export { XidFailed } from './components/control/xid-failed'
export type { XidFailedProps } from './components/control/xid-failed'

export { XidDegraded } from './components/control/xid-degraded'
export type { XidDegradedProps } from './components/control/xid-degraded'

export { AuthenticateWithRedirectCallback } from './components/control/authenticate-with-redirect-callback'
export type { AuthenticateWithRedirectCallbackProps } from './components/control/authenticate-with-redirect-callback'

export { RedirectToSignIn } from './components/control/redirect-to-sign-in'
export type { RedirectToSignInProps } from './components/control/redirect-to-sign-in'

export { RedirectToSignUp } from './components/control/redirect-to-sign-up'
export type { RedirectToSignUpProps } from './components/control/redirect-to-sign-up'

export { RedirectToUserProfile } from './components/control/redirect-to-user-profile'
export type { RedirectToUserProfileProps } from './components/control/redirect-to-user-profile'

export { RedirectToOrganizationProfile } from './components/control/redirect-to-organization-profile'
export type { RedirectToOrganizationProfileProps } from './components/control/redirect-to-organization-profile'

export { RedirectToCreateOrganization } from './components/control/redirect-to-create-organization'
export type { RedirectToCreateOrganizationProps } from './components/control/redirect-to-create-organization'

export { SignInButton } from './components/control/sign-in-button'
export type { SignInButtonProps } from './components/control/sign-in-button'

export { SignOutButton } from './components/control/sign-out-button'
export type { SignOutButtonProps } from './components/control/sign-out-button'

export { SignUpButton } from './components/control/sign-up-button'
export type { SignUpButtonProps } from './components/control/sign-up-button'

// --- UI components ---
export { SignIn } from './components/ui/sign-in'
export type { SignInProps } from './components/ui/sign-in'

export { SignUp } from './components/ui/sign-up'
export type { SignUpProps } from './components/ui/sign-up'

export { UserAvatar } from './components/ui/user-avatar'
export type { UserAvatarProps } from './components/ui/user-avatar'

export { UserButton } from './components/ui/user-button'
export type { UserButtonProps } from './components/ui/user-button'

export { UserProfile } from './components/ui/user-profile'
export type { UserProfileProps } from './components/ui/user-profile'

export { GuestUpgradeBanner } from './components/ui/guest-upgrade-banner'
export type { GuestUpgradeBannerProps } from './components/ui/guest-upgrade-banner'

// --- Organization components ---
export { OrganizationSwitcher } from './components/organization/organization-switcher'
export type { OrganizationSwitcherProps } from './components/organization/organization-switcher'

export { OrganizationProfile } from './components/organization/organization-profile'
export type { OrganizationProfileProps } from './components/organization/organization-profile'

export { CreateOrganization } from './components/organization/create-organization'
export type { CreateOrganizationProps } from './components/organization/create-organization'

export { OrganizationList } from './components/organization/organization-list'
export type { OrganizationListProps } from './components/organization/organization-list'

// --- Appearance ---
export type { Appearance, AppearanceVariables, AppearanceElements } from './appearance'

export type { OrganizationMembershipRole } from '@xid-kit/types'

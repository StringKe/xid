import type { ReactNode } from 'react'

import { useXidRnContext } from './xid-rn-context'
import type { NativeIdTokenClaims } from './id-token'
import type { StoredTokenSet } from './token-exchange'

export type NativeUser = {
  id: string
  email: string | null
  emailVerified: boolean
  name: string | null
  givenName: string | null
  familyName: string | null
  picture: string | null
  phoneNumber: string | null
  phoneNumberVerified: boolean
  organizationId: string | null
  organizationSlug: string | null
  organizationName: string | null
  provisionedBy: string | null
  isAnonymous: boolean
}

export type UseAuthReturn = {
  isLoaded: boolean
  isSignedIn: boolean
  isAnonymous: boolean
  userId: string | null
  sessionId: string | null
  session: StoredTokenSet | null
  getToken: () => Promise<string | null>
  signOut: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const { isLoaded, session, getAccessToken, signOut } = useXidRnContext()
  const claims = session?.claims
  const hasVerifiedSession = session !== null && claims !== null
  return {
    isLoaded,
    isSignedIn: hasVerifiedSession,
    isAnonymous: claims?.provisioned_by === 'anonymous',
    userId: claims?.sub ?? null,
    sessionId: typeof claims?.sid === 'string' ? claims.sid : null,
    session: hasVerifiedSession ? session : null,
    getToken: hasVerifiedSession ? getAccessToken : async () => null,
    signOut,
  }
}

export type UseUserReturn =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: NativeUser }

export function useUser(): UseUserReturn {
  const { isLoaded, session } = useXidRnContext()
  if (!isLoaded) return { isLoaded: false, isSignedIn: false, user: null }
  if (!session?.claims) return { isLoaded: true, isSignedIn: false, user: null }
  return {
    isLoaded: true,
    isSignedIn: true,
    user: userFromClaims(session.claims),
  }
}

export type UseSessionReturn =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | {
      isLoaded: true
      isSignedIn: true
      session: StoredTokenSet
      getToken: () => Promise<string | null>
    }

export function useSession(): UseSessionReturn {
  const { isLoaded, session, getAccessToken } = useXidRnContext()
  if (!isLoaded) return { isLoaded: false, isSignedIn: false, session: null }
  if (!session?.claims) return { isLoaded: true, isSignedIn: false, session: null }
  return {
    isLoaded: true,
    isSignedIn: true,
    session,
    getToken: getAccessToken,
  }
}

export type AuthControlProps = {
  children: ReactNode
}

export function SignedIn({ children }: AuthControlProps): ReactNode {
  const { isLoaded, isSignedIn } = useAuth()
  return isLoaded && isSignedIn ? children : null
}

export function SignedOut({ children }: AuthControlProps): ReactNode {
  const { isLoaded, isSignedIn } = useAuth()
  return isLoaded && !isSignedIn ? children : null
}

export function XidLoaded({ children }: AuthControlProps): ReactNode {
  return useAuth().isLoaded ? children : null
}

export function XidLoading({ children }: AuthControlProps): ReactNode {
  return useAuth().isLoaded ? null : children
}

function userFromClaims(claims: NativeIdTokenClaims): NativeUser {
  const provisionedBy = typeof claims.provisioned_by === 'string' ? claims.provisioned_by : null
  return {
    id: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : null,
    givenName: typeof claims.given_name === 'string' ? claims.given_name : null,
    familyName: typeof claims.family_name === 'string' ? claims.family_name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
    phoneNumber: typeof claims.phone_number === 'string' ? claims.phone_number : null,
    phoneNumberVerified: claims.phone_number_verified === true,
    organizationId: typeof claims.org_id === 'string' ? claims.org_id : null,
    organizationSlug: typeof claims.org_slug === 'string' ? claims.org_slug : null,
    organizationName: typeof claims.org_name === 'string' ? claims.org_name : null,
    provisionedBy,
    isAnonymous: provisionedBy === 'anonymous',
  }
}

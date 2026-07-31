import type { ReactElement, ReactNode } from 'react'
import { Fragment } from 'react'

import { Trans } from '@lingui/react'
import type { useLingui } from '@lingui/react'

type RuntimeTranslate = ReturnType<typeof useLingui>['_']

type RuntimeMessage = {
  id: string
  message: string
}

type RuntimeTransProps = RuntimeMessage & {
  values?: Record<string, string | number>
  components?: Record<string | number, ReactElement>
}

export const sdkMessages = {
  alreadyHaveAccountSignIn: /*i18n*/ {
    id: 'sdk.alreadyHaveAccountSignIn',
    message: 'Already have an account? <0>Sign in</0>',
  },
  continue: /*i18n*/ {
    id: 'sdk.continue',
    message: 'Continue',
  },
  continueToSignIn: /*i18n*/ {
    id: 'sdk.continueToSignIn',
    message: 'Continue to sign in',
  },
  continueToSignUp: /*i18n*/ {
    id: 'sdk.continueToSignUp',
    message: 'Continue to sign up',
  },
  createOrganization: /*i18n*/ {
    id: 'sdk.createOrganization',
    message: 'Create organization',
  },
  createOrganizationWithPrefix: /*i18n*/ {
    id: 'sdk.createOrganizationWithPrefix',
    message: '+ Create organization',
  },
  createYourAccount: /*i18n*/ {
    id: 'sdk.createYourAccount',
    message: 'Create your account',
  },
  dontHaveAccountSignUp: /*i18n*/ {
    id: 'sdk.dontHaveAccountSignUp',
    message: "Don't have an account? <0>Sign up</0>",
  },
  guestUpgradeAction: /*i18n*/ {
    id: 'sdk.guestUpgradeAction',
    message: 'Set up sign-in',
  },
  guestUpgradeMessage: /*i18n*/ {
    id: 'sdk.guestUpgradeMessage',
    message: 'You are browsing as a guest. Set up a sign-in method to keep your data.',
  },
  loading: /*i18n*/ {
    id: 'sdk.loading',
    message: 'Loading...',
  },
  manageAccount: /*i18n*/ {
    id: 'sdk.manageAccount',
    message: 'Manage account',
  },
  manageOrganization: /*i18n*/ {
    id: 'sdk.manageOrganization',
    message: 'Manage organization',
  },
  manageProfile: /*i18n*/ {
    id: 'sdk.manageProfile',
    message: 'Manage profile',
  },
  members: /*i18n*/ {
    id: 'sdk.members',
    message: '{count} members',
  },
  noOrganizationsYet: /*i18n*/ {
    id: 'sdk.noOrganizationsYet',
    message: 'No organizations yet.',
  },
  organizationList: /*i18n*/ {
    id: 'sdk.organizationList',
    message: 'Organization list',
  },
  organizationProfile: /*i18n*/ {
    id: 'sdk.organizationProfile',
    message: 'Organization profile',
  },
  personalAccount: /*i18n*/ {
    id: 'sdk.personalAccount',
    message: 'Personal account',
  },
  selectOrganization: /*i18n*/ {
    id: 'sdk.selectOrganization',
    message: 'Select organization',
  },
  signIn: /*i18n*/ {
    id: 'sdk.signIn',
    message: 'Sign in',
  },
  signInForm: /*i18n*/ {
    id: 'sdk.signInForm',
    message: 'Sign in form',
  },
  signOut: /*i18n*/ {
    id: 'sdk.signOut',
    message: 'Sign out',
  },
  signOutFailed: /*i18n*/ {
    id: 'sdk.signOutFailed',
    message: 'Could not sign out. Try again.',
  },
  signUp: /*i18n*/ {
    id: 'sdk.signUp',
    message: 'Sign up',
  },
  signUpForm: /*i18n*/ {
    id: 'sdk.signUpForm',
    message: 'Sign up form',
  },
  switchSession: /*i18n*/ {
    id: 'sdk.switchSession',
    message: 'Switch session',
  },
  user: /*i18n*/ {
    id: 'sdk.user',
    message: 'User',
  },
  userAvatar: /*i18n*/ {
    id: 'sdk.userAvatar',
    message: 'User avatar',
  },
  userMenu: /*i18n*/ {
    id: 'sdk.userMenu',
    message: 'User menu',
  },
  userProfile: /*i18n*/ {
    id: 'sdk.userProfile',
    message: 'User profile',
  },
} satisfies Record<string, RuntimeMessage>

export function rt(translate: RuntimeTranslate, descriptor: RuntimeMessage): string {
  return translate(descriptor)
}

export function Rt({ id, message, values, components }: RuntimeTransProps): ReactNode {
  return (
    <Trans
      id={id}
      message={message}
      values={values}
      components={components}
      render={({ translation }) => <Fragment>{translation}</Fragment>}
    />
  )
}

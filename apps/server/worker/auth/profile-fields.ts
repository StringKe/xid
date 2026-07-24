import type {
  HostedAuthPolicy,
  HostedAuthProfileField,
  HostedAuthProfileFields,
  ProfileFieldMode,
  TenantContext,
} from '@xid-kit/types'
import { normalizeHostedAuthProfileFields } from '@xid-kit/types'
import { HostedAuthPolicyError } from './hosted-policy'

export type ProfileFieldInput = {
  email?: string | null
  username?: string | null
  phone?: string | null
  name?: string | null
  givenName?: string | null
  familyName?: string | null
}

export type NormalizedProfileFields = {
  username: string | null
  phone: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  displayName: string | null
  profileCompletionStatus: 'complete' | 'incomplete'
}

const PROFILE_KEYS: readonly HostedAuthProfileField[] = [
  'email',
  'username',
  'phone',
  'name',
  'givenName',
  'familyName',
]

function profileFields(policy: HostedAuthPolicy | undefined): HostedAuthProfileFields {
  return normalizeHostedAuthProfileFields(policy?.profileFields)
}

function modeFor(
  policy: HostedAuthPolicy | undefined,
  field: HostedAuthProfileField,
): ProfileFieldMode {
  return profileFields(policy)[field]
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function valueFor(
  fields: HostedAuthProfileFields,
  field: HostedAuthProfileField,
  input: ProfileFieldInput,
  identity: ProfileFieldInput,
): string | null {
  const identityValue = clean(identity[field])
  if (identityValue)
    return field === 'email' || field === 'username' ? identityValue.toLowerCase() : identityValue
  if (fields[field] === 'hidden') return null
  const inputValue = clean(input[field])
  if (!inputValue) return null
  return field === 'email' || field === 'username' ? inputValue.toLowerCase() : inputValue
}

function displayName(input: ProfileFieldInput, fields: HostedAuthProfileFields): string | null {
  const directName = fields.name === 'hidden' ? null : clean(input.name)
  if (directName) return directName
  const parts = [
    fields.givenName === 'hidden' ? null : clean(input.givenName),
    fields.familyName === 'hidden' ? null : clean(input.familyName),
  ].filter((value): value is string => value !== null)
  return parts.length > 0 ? parts.join(' ') : null
}

export function profileFieldRequired(
  tenant: TenantContext,
  field: HostedAuthProfileField,
): boolean {
  return modeFor(tenant.policy?.hostedAuth, field) === 'required'
}

export function visibleProfileFieldKeys(
  policy: HostedAuthPolicy | undefined,
): readonly HostedAuthProfileField[] {
  const fields = profileFields(policy)
  return PROFILE_KEYS.filter((field) => fields[field] !== 'hidden')
}

export function normalizeProfileFields(
  tenant: TenantContext,
  input: ProfileFieldInput,
  identity: ProfileFieldInput = {},
): NormalizedProfileFields {
  const policy = tenant.policy?.hostedAuth
  const fields = profileFields(policy)
  const normalized = {
    email: valueFor(fields, 'email', input, identity),
    username: valueFor(fields, 'username', input, identity),
    phone: valueFor(fields, 'phone', input, identity),
    firstName: valueFor(fields, 'givenName', input, identity),
    lastName: valueFor(fields, 'familyName', input, identity),
    displayName: displayName(input, fields),
  }
  const missing = PROFILE_KEYS.filter((field) => {
    if (fields[field] !== 'required') return false
    if (field === 'email') return normalized.email === null
    if (field === 'username') return normalized.username === null
    if (field === 'phone') return normalized.phone === null
    if (field === 'name') return normalized.displayName === null
    if (field === 'givenName') return normalized.firstName === null
    return normalized.lastName === null
  })
  if (missing.length > 0) {
    throw new HostedAuthPolicyError('profile_field_required')
  }
  const incomplete = PROFILE_KEYS.some((field) => {
    if (fields[field] === 'hidden') return false
    if (field === 'email') return normalized.email === null
    if (field === 'username') return normalized.username === null
    if (field === 'phone') return normalized.phone === null
    if (field === 'name') return normalized.displayName === null
    if (field === 'givenName') return normalized.firstName === null
    return normalized.lastName === null
  })
  return {
    ...normalized,
    profileCompletionStatus: incomplete ? 'incomplete' : 'complete',
  }
}

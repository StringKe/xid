// 登录页字段:identifier 标签/占位/无障碍名按 identifierMode 取文案;注册资料字段按策略渲染。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Field, Input } from '../../components/ui'
import type { IdentifierPrompt, ProfileFieldKey } from './shared'

export function IdentifierLabel({ prompt }: { prompt: IdentifierPrompt }): ReactNode {
  switch (prompt.mode) {
    case 'username':
      return <Trans>Username</Trans>
    case 'email_or_username':
      return <Trans>Email or username</Trans>
    case 'phone':
      return <Trans>Phone number</Trans>
    case 'external_id':
      return <Trans>External ID</Trans>
    case 'email':
    default:
      return <Trans>Email address</Trans>
  }
}

export function useIdentifierPlaceholder(prompt: IdentifierPrompt): string {
  const { t } = useLingui()
  switch (prompt.mode) {
    case 'username':
      return t`username`
    case 'phone':
      return t`+1 555 000 0000`
    case 'external_id':
      return t`external-id`
    case 'email':
    case 'email_or_username':
    default:
      return t`you@example.com`
  }
}

export function useIdentifierAriaLabel(prompt: IdentifierPrompt): string {
  const { t } = useLingui()
  switch (prompt.mode) {
    case 'username':
      return t`Username`
    case 'email_or_username':
      return t`Email or username`
    case 'phone':
      return t`Phone number`
    case 'external_id':
      return t`External ID`
    case 'email':
    default:
      return t`Email address`
  }
}

function ProfileFieldInput({
  field,
  value,
  required,
  disabled,
  onChange,
}: {
  field: ProfileFieldKey
  value: string
  required: boolean
  disabled: boolean
  onChange: (field: ProfileFieldKey, value: string) => void
}): ReactNode {
  const { t } = useLingui()
  const label =
    field === 'username' ? (
      <Trans>Username</Trans>
    ) : field === 'phone' ? (
      <Trans>Phone number</Trans>
    ) : field === 'name' ? (
      <Trans>Name</Trans>
    ) : field === 'givenName' ? (
      <Trans>First name</Trans>
    ) : field === 'familyName' ? (
      <Trans>Last name</Trans>
    ) : (
      <Trans>Email address</Trans>
    )
  return (
    <Field label={label} required={required}>
      <Input
        type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
        autoComplete={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'name'}
        placeholder={field === 'email' ? t`you@example.com` : ''}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={disabled}
      />
    </Field>
  )
}

export function ProfileFields({
  fields,
  requiredFields,
  values,
  disabled,
  onChange,
}: {
  fields: readonly ProfileFieldKey[]
  requiredFields: readonly ProfileFieldKey[]
  values: Record<ProfileFieldKey, string>
  disabled: boolean
  onChange: (field: ProfileFieldKey, value: string) => void
}): ReactNode {
  if (fields.length === 0) return null
  return (
    <>
      {fields.map((field) => (
        <ProfileFieldInput
          key={field}
          field={field}
          value={values[field]}
          required={requiredFields.includes(field)}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </>
  )
}

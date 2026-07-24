// 密码修改区:current + new + confirm 三字段表单 + 服务端错误映射。
// 状态与 mutation 完全自包含,经 Section/SectionRow 共享骨架渲染。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Section, SectionRow } from '../../components/ui'
import { trackPasswordChanged } from '../../lib/google-analytics-funnel'
import { useChangePassword } from './queries'

const styles = stylex.create({
  formFooter: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    // hairline 邻接 >= 1.25rem:SectionRow 末行底线到提交按钮文本 >= 1.25rem
    paddingBlockStart: '1.25rem',
    paddingBlockEnd: '0.875rem',
  },
  submitBtn: {
    alignSelf: 'flex-start',
  },
})

export function ChangePasswordSection(): ReactNode {
  const { t } = useLingui()
  const changePassword = useChangePassword()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFieldErrors({})
    setErrorMsg(null)
    setSuccessMsg(null)

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: t`Passwords do not match.` })
      return
    }
    if (newPassword.length < 12) {
      setFieldErrors({ newPassword: t`Password must be at least 12 characters.` })
      return
    }

    try {
      await changePassword.mutateAsync({ currentPassword, newPassword })
      trackPasswordChanged()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccessMsg(t`Password updated successfully.`)
    } catch (err) {
      const xidErr = err as {
        message?: string
        longMessage?: string
        meta?: { paramName?: string }
      }
      if (xidErr.meta?.paramName) {
        setFieldErrors({ [xidErr.meta.paramName]: xidErr.longMessage || xidErr.message || '' })
      } else {
        setErrorMsg(xidErr.longMessage || xidErr.message || t`Failed to update password.`)
      }
    }
  }

  return (
    <Section label={<Trans>Change password</Trans>}>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <SectionRow variant="control" label={<Trans>Current password</Trans>}>
          <Field required error={fieldErrors.currentPassword}>
            <Input
              type="password"
              aria-label={t`Current password`}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
        </SectionRow>

        <SectionRow variant="control" label={<Trans>New password</Trans>}>
          <Field required error={fieldErrors.newPassword}>
            <Input
              type="password"
              aria-label={t`New password`}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </SectionRow>

        <SectionRow variant="control" label={<Trans>Confirm new password</Trans>}>
          <Field required error={fieldErrors.confirmPassword}>
            <Input
              type="password"
              aria-label={t`Confirm new password`}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </SectionRow>

        <div {...stylex.props(styles.formFooter)}>
          {errorMsg ? <Alert tone="error">{errorMsg}</Alert> : null}
          {successMsg ? <Alert tone="success">{successMsg}</Alert> : null}
          <Button
            type="submit"
            variant="primary"
            isLoading={changePassword.isPending}
            {...stylex.props(styles.submitBtn)}
          >
            <Trans>Update password</Trans>
          </Button>
        </div>
      </form>
    </Section>
  )
}

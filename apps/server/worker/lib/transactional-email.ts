// 事务邮件入队:locale 必填,邮件 consumer 按它选模板(缺省才回落 en)。

export type TransactionalEmail = {
  type: string
  recipient: string
  locale: string
  payload: Record<string, unknown>
}

export async function enqueueTransactionalEmail(
  env: Env,
  email: TransactionalEmail,
): Promise<void> {
  await env.EMAIL_QUEUE.send({
    type: email.type,
    recipient: email.recipient,
    payload: { ...email.payload, locale: email.locale },
  })
}

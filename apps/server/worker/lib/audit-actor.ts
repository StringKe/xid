export const DELETED_AUDIT_ACTOR = '[deleted_user]'

export function auditActorDisplay(
  actorId: string | null,
  identity: { found: boolean; erasedAt: Date | number | null },
): string | null {
  if (actorId === null) return null
  if (actorId === 'system') return actorId
  if (!identity.found || identity.erasedAt !== null) return DELETED_AUDIT_ACTOR
  return actorId
}

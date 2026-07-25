import { describe, expect, it } from 'vitest'
import { isBlockedDocsRoutePath, isInternalRepositoryDocsFsPath } from './dev-server-guard'

const prefix = '/@fs/workspace/xid/docs'
const prefixWithTrailingSlash = `${prefix}/`

describe('docs dev server guard', () => {
  it('blocks the internal repository docs directory through Vite fs paths', () => {
    expect(isInternalRepositoryDocsFsPath(prefix, prefixWithTrailingSlash)).toBe(true)
    expect(
      isInternalRepositoryDocsFsPath(`${prefix}/design/README.md`, prefixWithTrailingSlash),
    ).toBe(true)
    expect(isInternalRepositoryDocsFsPath(`${prefix}/goal.md`, prefixWithTrailingSlash)).toBe(true)
    expect(
      isInternalRepositoryDocsFsPath(`${prefix}/assets/logo.png`, prefixWithTrailingSlash),
    ).toBe(true)
  })

  it('blocks the encoded Vite fs redirect form', () => {
    expect(
      isInternalRepositoryDocsFsPath(
        '/%40fs/workspace/xid/docs/design/README.md',
        prefixWithTrailingSlash,
      ),
    ).toBe(true)
  })

  it('does not block public app sources or adjacent path prefixes', () => {
    expect(
      isInternalRepositoryDocsFsPath(
        '/@fs/workspace/xid/apps/server/src/routes/docs/index.tsx',
        prefixWithTrailingSlash,
      ),
    ).toBe(false)
    expect(
      isInternalRepositoryDocsFsPath(`${prefix}-archive/README.md`, prefixWithTrailingSlash),
    ).toBe(false)
  })

  it('blocks non-public docs SPA paths in development', () => {
    expect(isBlockedDocsRoutePath('/docs/design')).toBe(true)
    expect(isBlockedDocsRoutePath('/docs/goal')).toBe(true)
    expect(isBlockedDocsRoutePath('/docs/verification')).toBe(true)
    expect(isBlockedDocsRoutePath('/docs/deployment')).toBe(true)
    expect(isBlockedDocsRoutePath('/docs/api-contracts')).toBe(true)
    expect(isBlockedDocsRoutePath('/docs/scim')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs/enterprise-sso')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs/social-login')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs/sdks')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs/sdks/core')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs/sdks/react')).toBe(false)
    expect(isBlockedDocsRoutePath('/docs')).toBe(false)
  })
})

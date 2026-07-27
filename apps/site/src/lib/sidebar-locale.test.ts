import { describe, expect, it } from 'vitest'
import type { SidebarItem, SidebarSection } from '@cloudflare/nimbus-docs/types'
import { scopeSidebarSectionsToSiteLocale, scopeSidebarToSiteLocale } from './sidebar-locale'

const deDocsGroup: SidebarItem = {
  type: 'group',
  label: 'Dokumentation',
  order: 0,
  indexHref: '/de/',
  children: [],
}

const englishGettingStarted: SidebarItem = {
  type: 'link',
  label: 'Getting started',
  href: '/getting-started/',
  order: 0,
}

const englishSdks: SidebarItem = {
  type: 'group',
  label: 'SDKs',
  order: 1,
  indexHref: '/sdks/',
  children: [],
}

const tree: SidebarItem[] = [
  englishGettingStarted,
  englishSdks,
  deDocsGroup,
  {
    type: 'group',
    label: '简体中文',
    order: 2,
    indexHref: '/zh-hans/',
    children: [],
  },
]

const sections: SidebarSection[] = [
  {
    label: 'Deutsch',
    href: '/de/',
    isActive: false,
  },
  {
    label: 'Components',
    href: '/components/',
    isActive: false,
  },
  {
    label: '简体中文',
    href: '/zh-hans/',
    isActive: false,
  },
]

describe('localized sidebar', () => {
  it('keeps only the current locale tree', () => {
    expect(scopeSidebarToSiteLocale(tree, '/getting-started/')).toEqual([
      englishGettingStarted,
      englishSdks,
    ])
    expect(scopeSidebarToSiteLocale(tree, '/zh-hans/getting-started/')).toEqual([tree[3]])
    expect(scopeSidebarToSiteLocale(tree, '/de/')).toEqual([deDocsGroup])
  })

  it('keeps only the current locale header section', () => {
    expect(scopeSidebarSectionsToSiteLocale(sections, '/de/getting-started/')).toEqual([
      sections[0],
    ])
    expect(scopeSidebarSectionsToSiteLocale(sections, '/getting-started/')).toEqual([sections[1]])
  })

  it('fails when the locale boundary is missing', () => {
    const withoutFrench = tree.filter((item) => item.type !== 'group' || item.indexHref !== '/fr/')
    expect(() => scopeSidebarToSiteLocale(withoutFrench, '/fr/getting-started/')).toThrow(
      'expected one sidebar group for /fr, received 0',
    )
  })
})

import type { Breadcrumb, PrevNext } from '@cloudflare/nimbus-docs/types'
import documentSource from '../content-source/docs/documents.json'
import { renderPlainText } from '../content-source/docs/render-markdown'
import {
  parentDocumentSlug,
  type DocumentAstBundle,
  type RichText,
} from '../content-source/docs/types'
import { translateSiteMessage } from './site-i18n'
import { getSiteLocale, localizeSitePath } from './site-locale'

const bundle = documentSource as unknown as DocumentAstBundle

export type DocsNavLink = {
  slug: string
  href: string
  label: string
  summary: string
  isCurrent: boolean
  children: readonly DocsNavLink[]
}

export type DocsNavGroup = {
  id: string
  label: string
  links: readonly DocsNavLink[]
}

export type DocsNavigation = {
  hub: { href: string; label: string; summary: string; isCurrent: boolean }
  groups: readonly DocsNavGroup[]
}

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/u, '') || '/'
}

function translate(pathname: string, value: RichText): string {
  return renderPlainText(value, {
    locale: getSiteLocale(pathname),
    translate: (descriptor) =>
      translateSiteMessage(
        pathname,
        { id: descriptor.id, message: descriptor.message },
        Object.fromEntries(
          Object.entries(descriptor.values).map(([name, messageValue]) => [
            name,
            messageValue.value,
          ]),
        ),
      ),
  })
}

function groupId(index: number): string {
  return `group-${index + 1}`
}

export function getDocsNavigation(pathname: string): DocsNavigation {
  const current = normalize(pathname)
  const locale = getSiteLocale(pathname)
  const published = bundle.documents.filter((document) => document.draft !== true)
  const toLink = (slug: string, summary: RichText): DocsNavLink | null => {
    const document = published.find((candidate) => candidate.slug === slug)
    if (!document) return null
    const href = localizeSitePath(`/${slug}`, locale)
    const children =
      parentDocumentSlug(slug) === slug
        ? published
            .filter((child) => child.slug !== slug && parentDocumentSlug(child.slug) === slug)
            .flatMap((child) => toLink(child.slug, child.summary) ?? [])
        : []
    return {
      slug,
      href,
      label: translate(pathname, document.title),
      summary: translate(pathname, summary),
      isCurrent: normalize(href) === current,
      children,
    }
  }
  const hubHref = localizeSitePath('/docs', locale)
  return {
    hub: {
      href: hubHref,
      label: translate(pathname, bundle.hub.title),
      summary: translate(pathname, bundle.hub.summary),
      isCurrent: normalize(hubHref) === current,
    },
    groups: bundle.hub.groups.map((group, index) => ({
      id: groupId(index),
      label: translate(pathname, group.label),
      links: group.items.flatMap((item) => toLink(item.slug, item.summary) ?? []),
    })),
  }
}

function flatten(navigation: DocsNavigation): { href: string; label: string }[] {
  return [
    navigation.hub,
    ...navigation.groups.flatMap((group) =>
      group.links.flatMap((link) => [link, ...link.children]),
    ),
  ]
}

export function getDocsPrevNext(navigation: DocsNavigation, pathname: string): PrevNext {
  const pages = flatten(navigation)
  const index = pages.findIndex((page) => normalize(page.href) === normalize(pathname))
  if (index === -1) return {}
  const prev = pages[index - 1]
  const next = pages[index + 1]
  return {
    ...(prev ? { prev: { label: prev.label, href: prev.href } } : {}),
    ...(next ? { next: { label: next.label, href: next.href } } : {}),
  }
}

export function getDocsBreadcrumbs(navigation: DocsNavigation, pathname: string): Breadcrumb[] {
  const current = normalize(pathname)
  for (const group of navigation.groups) {
    for (const link of group.links) {
      const groupCrumb = { label: group.label, href: `${navigation.hub.href}#${group.id}` }
      if (normalize(link.href) === current) return [groupCrumb, { label: link.label }]
      const child = link.children.find((candidate) => normalize(candidate.href) === current)
      if (child) return [groupCrumb, { label: link.label, href: link.href }, { label: child.label }]
    }
  }
  return []
}

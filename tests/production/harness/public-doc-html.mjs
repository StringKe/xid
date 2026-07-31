function tagHasAttributes(body, tagName, attributes) {
  const tags = body.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gu')) ?? []
  return tags.some((tag) =>
    Object.entries(attributes).every(([name, value]) => tag.includes(`${name}="${value}"`)),
  )
}

function jsonLdMatches(body, canonicalUrl, language) {
  const scripts = [
    ...body.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu),
  ]
  return scripts.some((match) => {
    try {
      const value = JSON.parse(match[1])
      return value?.url === canonicalUrl && value.inLanguage === language
    } catch {
      return false
    }
  })
}

export function docsAuthActionsOk(body, locale) {
  return (
    body.includes(`href="/sign-in?locale=${locale}"`) &&
    body.includes(`href="/sign-in?intent=sign-up&amp;locale=${locale}"`)
  )
}

export function docsLocaleMetadataOk(body, { language, ogLocale, canonicalUrl, llmsIndexUrl }) {
  return (
    tagHasAttributes(body, 'html', { lang: language }) &&
    tagHasAttributes(body, 'meta', { property: 'og:locale', content: ogLocale }) &&
    tagHasAttributes(body, 'link', {
      rel: 'alternate',
      type: 'text/plain',
      href: llmsIndexUrl,
    }) &&
    jsonLdMatches(body, canonicalUrl, language)
  )
}

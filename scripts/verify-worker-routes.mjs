import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONSOLE_EXACT_PATH,
  EXPECTED_WORKER_ROUTE_CONFIGS,
  EXPECTED_WORKER_SERVICE_BINDINGS,
  SITE_EXACT_PATHS,
  SITE_PUBLIC_DOC_EXACT_PATHS,
  SITE_SCIM_DOC_EXACT_PATHS,
  XID_SITE_LOCALE_ROUTE_SEGMENTS,
  XID_SITE_LOCALES,
  resolveWebRouteOwnership,
} from '../packages/types/src/web-route-ownership.ts'
import { PUBLIC_DOC_SLUGS } from '../packages/types/src/public-docs.ts'

const OWNER_NAMES = ['site', 'console', 'core']
const EXPECTED_WORKER_NAMES = {
  site: 'xid-site',
  console: 'xid-console',
  core: 'xid',
}
const DEFAULT_CONFIG_PATHS = {
  site: 'apps/site/wrangler.jsonc',
  console: 'apps/console/wrangler.jsonc',
  core: 'apps/server/wrangler.jsonc',
}

function stripJsoncComments(source) {
  let output = ''
  let index = 0
  let inString = false
  let escaped = false

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n'
        index += 1
      }
      if (index >= source.length) throw new Error('Unterminated JSONC block comment')
      index += 2
      continue
    }

    output += char
    index += 1
  }

  if (inString) throw new Error('Unterminated JSONC string')
  return output
}

function stripTrailingCommas(source) {
  let output = ''
  let index = 0
  let inString = false
  let escaped = false

  while (index < source.length) {
    const char = source[index]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }

    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < source.length && /\s/u.test(source[lookahead])) lookahead += 1
      if (source[lookahead] === ']' || source[lookahead] === '}') {
        index += 1
        continue
      }
    }

    output += char
    index += 1
  }

  return output
}

export function parseJsonc(source, label = 'JSONC input') {
  try {
    return JSON.parse(stripTrailingCommas(stripJsoncComments(source)))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: ${detail}`)
  }
}

function normalizeRoutes(config, owner, errors) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.routes)) {
    errors.push(`${owner}: routes must be an array`)
    return []
  }

  return config.routes.flatMap((route, index) => {
    if (typeof route === 'string') {
      return [{ pattern: route, customDomain: false }]
    }

    if (!route || typeof route !== 'object' || typeof route.pattern !== 'string') {
      errors.push(`${owner}: routes[${index}] must be a pattern string or route object`)
      return []
    }

    if (route.custom_domain !== undefined && typeof route.custom_domain !== 'boolean') {
      errors.push(`${owner}: routes[${index}].custom_domain must be boolean`)
      return []
    }

    return [{ pattern: route.pattern, customDomain: route.custom_domain === true }]
  })
}

function routeKey(route) {
  return `${route.customDomain ? 'custom-domain' : 'route'}:${route.pattern}`
}

function normalizeServices(config, owner, errors) {
  if (config.services === undefined) return []
  if (!Array.isArray(config.services)) {
    errors.push(`${owner}: services must be an array`)
    return []
  }

  return config.services.flatMap((service, index) => {
    if (
      !service ||
      typeof service !== 'object' ||
      typeof service.binding !== 'string' ||
      typeof service.service !== 'string'
    ) {
      errors.push(`${owner}: services[${index}] must declare string binding and service`)
      return []
    }
    return [{ binding: service.binding, service: service.service }]
  })
}

function serviceKey(service) {
  return `${service.binding}:${service.service}`
}

function routeWitnessUrl(route) {
  if (route.customDomain) return `https://${route.pattern}/core-route-contract`

  let value = route.pattern
  if (value.startsWith('*.')) value = `tenant.${value.slice(2)}`
  value = value.replaceAll('*', 'route-contract')
  if (!value.includes('/')) value += '/'
  return `https://${value}`
}

function routeMatchesUrl(route, url) {
  if (route.customDomain) return url.hostname === route.pattern

  const escapedParts = route.pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'))
  const pattern = new RegExp(`^${escapedParts.join('.*')}$`, 'u')
  return pattern.test(`${url.hostname}${url.pathname}${url.search}`)
}

function routeSpecificity(route) {
  if (route.customDomain) return route.pattern.length
  return route.pattern.replaceAll('*', '').length
}

function verifyEffectiveOwnership(actualByOwner, actualServicesByOwner, errors) {
  const configuredRoutes = OWNER_NAMES.flatMap((owner) =>
    actualByOwner[owner].map((route) => ({ ...route, owner })),
  )
  const witnessUrls = new Set([
    ...OWNER_NAMES.flatMap((owner) => EXPECTED_WORKER_ROUTE_CONFIGS[owner].map(routeWitnessUrl)),
    'https://xid.dev/authorize',
    'https://tenant.xid.dev/.well-known/openid-configuration',
    'https://xid.dev/.well-known/llms.txt',
    'https://www.xid.dev/authorize',
    'https://www.xid.dev/console',
    'https://www.xid.dev/console/settings',
    'https://xid.dev/docs/not-a-public-doc',
    'https://xid.dev/status/',
    'https://xid.dev/en/llms.txt',
    'https://xid.dev/en/llms-full.txt',
    'https://xid.dev/scim/v2/Users',
    'https://xid.dev/scim/outbound/route-contract',
    ...[
      ...SITE_EXACT_PATHS,
      ...SITE_PUBLIC_DOC_EXACT_PATHS,
      ...SITE_SCIM_DOC_EXACT_PATHS,
      ...XID_SITE_LOCALES.map((locale) => `/${XID_SITE_LOCALE_ROUTE_SEGMENTS[locale]}`),
      CONSOLE_EXACT_PATH,
    ].map((pathname) => `https://xid.dev${pathname}?source=route-contract`),
    `https://tenant.xid.dev${CONSOLE_EXACT_PATH}?source=route-contract`,
    ...PUBLIC_DOC_SLUGS.flatMap((slug) => [
      `https://xid.dev/${slug}`,
      `https://xid.dev/${slug}/`,
      `https://xid.dev/${slug}/index.md`,
      `https://xid.dev/${slug}/index.mdx`,
    ]),
  ])

  for (const value of witnessUrls) {
    const url = new URL(value)
    const matchingRoutes = configuredRoutes
      .filter((route) => routeMatchesUrl(route, url))
      .sort((left, right) => routeSpecificity(right) - routeSpecificity(left))
    const winner = matchingRoutes[0]
    if (!winner) {
      errors.push(`no configured Worker route owns ${value}`)
      continue
    }

    const topScore = routeSpecificity(winner)
    const topOwners = new Set(
      matchingRoutes
        .filter((route) => routeSpecificity(route) === topScore)
        .map((route) => route.owner),
    )
    if (topOwners.size !== 1) {
      errors.push(`unresolved route overlap for ${value}: ${[...topOwners].join(', ')}`)
      continue
    }

    // `*/*` 由 Wrangler 绑到 provider zone；纯 URL 归属无法判断 SaaS 自定义域名是否进入该 zone，本校验器用该路由本身补上这个上下文。
    const expectedOwner =
      resolveWebRouteOwnership(url).owner ??
      (matchingRoutes.some((route) => route.owner === 'core' && route.pattern === '*/*')
        ? 'core'
        : null)
    const delegatedFrontendOwner =
      winner.owner === 'core' && (expectedOwner === 'site' || expectedOwner === 'console')
        ? expectedOwner
        : null
    const hasDelegationBinding =
      delegatedFrontendOwner !== null &&
      actualServicesByOwner.core.some(
        (service) =>
          service.binding ===
            (delegatedFrontendOwner === 'site' ? 'SITE_WORKER' : 'CONSOLE_WORKER') &&
          service.service === (delegatedFrontendOwner === 'site' ? 'xid-site' : 'xid-console'),
      )
    if (winner.owner !== expectedOwner && !hasDelegationBinding) {
      errors.push(
        `route owner mismatch for ${value}: config=${winner.owner}, contract=${expectedOwner}`,
      )
    }
  }
}

export function verifyWorkerRouteConfigs(configs) {
  const errors = []
  const actualByOwner = Object.fromEntries(
    OWNER_NAMES.map((owner) => [owner, normalizeRoutes(configs[owner], owner, errors)]),
  )
  const actualServicesByOwner = Object.fromEntries(
    OWNER_NAMES.map((owner) => [owner, normalizeServices(configs[owner], owner, errors)]),
  )
  const patternOwners = new Map()

  for (const owner of OWNER_NAMES) {
    if (configs[owner]?.name !== EXPECTED_WORKER_NAMES[owner]) {
      errors.push(`${owner}: name must be ${EXPECTED_WORKER_NAMES[owner]}`)
    }
    if (configs[owner]?.preview_urls !== false) {
      errors.push(`${owner}: preview_urls must be false`)
    }

    const actual = actualByOwner[owner]
    const expected = EXPECTED_WORKER_ROUTE_CONFIGS[owner]
    const actualKeys = new Set()

    for (const route of actual) {
      const key = routeKey(route)
      if (actualKeys.has(key)) errors.push(`${owner}: duplicate route ${key}`)
      actualKeys.add(key)

      const owners = patternOwners.get(route.pattern) ?? []
      owners.push(owner)
      patternOwners.set(route.pattern, owners)
    }

    const expectedKeys = new Set(expected.map(routeKey))
    for (const route of expected) {
      const key = routeKey(route)
      if (!actualKeys.has(key)) errors.push(`${owner}: missing route ${key}`)
    }
    for (const route of actual) {
      const key = routeKey(route)
      if (!expectedKeys.has(key)) errors.push(`${owner}: over-wide or unowned route ${key}`)
    }

    const actualServices = actualServicesByOwner[owner]
    const expectedServices = EXPECTED_WORKER_SERVICE_BINDINGS[owner]
    const actualServiceKeys = new Set(actualServices.map(serviceKey))
    const expectedServiceKeys = new Set(expectedServices.map(serviceKey))
    for (const service of expectedServices) {
      const key = serviceKey(service)
      if (!actualServiceKeys.has(key)) errors.push(`${owner}: missing service binding ${key}`)
    }
    for (const service of actualServices) {
      const key = serviceKey(service)
      if (!expectedServiceKeys.has(key)) {
        errors.push(`${owner}: unexpected service binding ${key}`)
      }
    }
  }

  for (const [pattern, owners] of patternOwners) {
    const uniqueOwners = [...new Set(owners)]
    if (uniqueOwners.length > 1) {
      errors.push(`unresolved duplicate pattern ${pattern}: ${uniqueOwners.join(', ')}`)
    }
  }

  verifyEffectiveOwnership(actualByOwner, actualServicesByOwner, errors)
  return errors
}

function parseConfigArguments(argv) {
  if (argv.length === 0) return { paths: DEFAULT_CONFIG_PATHS, explicit: false }
  if (argv.length % 2 !== 0) {
    throw new Error('Expected --site, --console, and --core path pairs')
  }

  const paths = {}
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    const owner = option?.startsWith('--') ? option.slice(2) : ''
    if (!OWNER_NAMES.includes(owner) || !value) {
      throw new Error('Expected --site, --console, and --core path pairs')
    }
    if (paths[owner]) throw new Error(`Duplicate --${owner} option`)
    paths[owner] = value
  }

  for (const owner of OWNER_NAMES) {
    if (!paths[owner]) throw new Error(`Missing --${owner} config path`)
  }
  return { paths, explicit: true }
}

export function runWorkerRouteVerification(argv = []) {
  const { paths, explicit } = parseConfigArguments(argv)
  const resolvedPaths = Object.fromEntries(
    OWNER_NAMES.map((owner) => [owner, resolve(process.cwd(), paths[owner])]),
  )
  const missing = OWNER_NAMES.filter((owner) => !existsSync(resolvedPaths[owner]))

  if (missing.length > 0) {
    const detail = missing.map((owner) => `${owner}=${resolvedPaths[owner]}`).join(', ')
    if (explicit) throw new Error(`Missing explicit Wrangler config: ${detail}`)
    return { status: 'SKIP', detail: `missing Wrangler config: ${detail}` }
  }

  const configs = Object.fromEntries(
    OWNER_NAMES.map((owner) => {
      const path = resolvedPaths[owner]
      return [owner, parseJsonc(readFileSync(path, 'utf8'), path)]
    }),
  )
  const errors = verifyWorkerRouteConfigs(configs)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return { status: 'PASS', detail: 'site, console, and core route configs match the contract' }
}

function main() {
  try {
    const result = runWorkerRouteVerification(process.argv.slice(2))
    process.stdout.write(`${result.status} worker routes: ${result.detail}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`FAIL worker routes: ${detail}\n`)
    process.exitCode = 1
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) main()

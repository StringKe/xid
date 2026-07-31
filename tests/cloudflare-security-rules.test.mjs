import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const manifestUrl = new URL('../docs/deployment/cloudflare-security-rules.v1.json', import.meta.url)
const schemaUrl = new URL(
  '../docs/deployment/cloudflare-security-rules.schema.json',
  import.meta.url,
)
const meAuthRoutesUrl = new URL('../apps/server/worker/me-auth/index.ts', import.meta.url)

const [manifest, schema, meAuthRoutes] = await Promise.all([
  readFile(manifestUrl, 'utf8').then(JSON.parse),
  readFile(schemaUrl, 'utf8').then(JSON.parse),
  readFile(meAuthRoutesUrl, 'utf8'),
])

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateSchema(value, definition, path = '$') {
  const errors = []
  if ('const' in definition && !sameJson(value, definition.const)) {
    errors.push(`${path} must equal ${JSON.stringify(definition.const)}`)
  }
  if (definition.enum && !definition.enum.some((candidate) => sameJson(value, candidate))) {
    errors.push(`${path} must be one of ${JSON.stringify(definition.enum)}`)
  }
  if (definition.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [...errors, `${path} must be an object`]
    }
    for (const key of definition.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`)
    }
    const properties = definition.properties ?? {}
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`)
      }
    }
    for (const [key, propertyDefinition] of Object.entries(properties)) {
      if (key in value)
        errors.push(...validateSchema(value[key], propertyDefinition, `${path}.${key}`))
    }
  }
  if (definition.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${path} must be an array`]
    if (definition.minItems !== undefined && value.length < definition.minItems) {
      errors.push(`${path} must contain at least ${String(definition.minItems)} items`)
    }
    if (definition.maxItems !== undefined && value.length > definition.maxItems) {
      errors.push(`${path} must contain at most ${String(definition.maxItems)} items`)
    }
    if (definition.uniqueItems && new Set(value.map(JSON.stringify)).size !== value.length) {
      errors.push(`${path} items must be unique`)
    }
    if (definition.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, definition.items, `${path}[${String(index)}]`))
      })
    }
  }
  if (definition.type === 'string') {
    if (typeof value !== 'string') return [...errors, `${path} must be a string`]
    if (definition.minLength !== undefined && value.length < definition.minLength) {
      errors.push(`${path} must not be empty`)
    }
    if (definition.pattern && !new RegExp(definition.pattern, 'u').test(value)) {
      errors.push(`${path} does not match ${definition.pattern}`)
    }
    if (definition.format === 'uri') {
      try {
        new URL(value)
      } catch {
        errors.push(`${path} must be an absolute URI`)
      }
    }
  }
  if (definition.type === 'integer') {
    if (!Number.isInteger(value)) return [...errors, `${path} must be an integer`]
    if (definition.minimum !== undefined && value < definition.minimum) {
      errors.push(`${path} must be at least ${String(definition.minimum)}`)
    }
  }
  return errors
}

function rulesetFor(phase) {
  return manifest.rulesets.find((ruleset) => ruleset.phase === phase)
}

describe('Cloudflare security rule manifest', () => {
  it('conforms to its offline JSON schema and uses an explicit reconciliation state', () => {
    expect(validateSchema(manifest, schema)).toEqual([])
    expect(manifest.schemaVersion).toBe(1)
    expect(['EXTERNAL', 'RECONCILED']).toContain(manifest.deploymentState)
    expect(manifest.authoritativeBusinessLimiter).toBe('RateLimitStore')
  })

  it('fits the Cloudflare Free WAF custom-rule boundary', () => {
    const custom = rulesetFor('http_request_firewall_custom')
    expect(custom.rules.length).toBeGreaterThan(0)
    expect(custom.rules.length).toBeLessThanOrEqual(manifest.planLimits.customRules)
    expect(manifest.planLimits.customRules).toBe(5)
    for (const rule of custom.rules) {
      expect(rule.action).toBe('block')
      expect(rule.expression).not.toMatch(/\bmatches\b/u)
      expect(rule.expression).not.toMatch(/\bcf\.bot_management\b/u)
      expect(rule.ratelimit).toBeUndefined()
    }
  })

  it('uses only the one Free-plan rate rule, Path expression, IP counter, and 10-second periods', () => {
    const rate = rulesetFor('http_ratelimit')
    expect(rate.rules).toHaveLength(1)
    expect(rate.rules.length).toBeLessThanOrEqual(manifest.planLimits.rateLimitingRules)
    expect(manifest.planLimits.rateLimitingRules).toBe(1)

    const [rule] = rate.rules
    const expressionFields = new Set(rule.expression.match(/\b(?:cf|http|ip)\.[a-z0-9_.]+/gu) ?? [])
    expect(expressionFields).toEqual(new Set(['http.request.uri.path']))
    expect(rule.ratelimit).toEqual({
      characteristics: ['cf.colo.id', 'ip.src'],
      period: 10,
      requests_per_period: 60,
      mitigation_timeout: 10,
    })

    const protectedPaths = [...rule.expression.matchAll(/"([^"]+)"/gu)].map((match) => match[1])
    expect(protectedPaths.length).toBeGreaterThan(0)
    for (const path of protectedPaths) {
      expect(meAuthRoutes).toContain(`'${path}'`)
    }
  })
})

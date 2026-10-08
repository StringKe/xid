import { describe, expect, it } from 'vitest'
import {
  capabilityGrade,
  findTableRowLine,
  parseProductionContracts,
  parseSourceMapLevels,
} from './pricing-evidence'

const SOURCE_MAP = [
  '| Feature | Standard source | Support | Evidence | Code path |',
  '| ------- | --------------- | ------- | -------- | --------- |',
  '| Authorization code | RFC 6749 | implemented | L1/L2/L3 | `a.ts` |',
  '| PAR | RFC 9126 | implemented | L1/L2/L3 | `b.ts` |',
  '| Webhook delivery | XID | implemented | L1/L2 | `c.ts` |',
  '| Audit event hash chain | XID | implemented | L1 | `d.ts` |',
  '| Shared Signals, CAEP, RISC | SSF | planned | L1 | `e.ts` |',
].join('\n')

const API_CONTRACTS = [
  '| Method | Path | Status | Notes |',
  '| ------ | ---- | ------ | ----- |',
  '| GET | `/auth/config` | production L4 | public configuration |',
  '| POST | `/auth/magic-link/send` | PASS | local only |',
].join('\n')

const sources = {
  levels: parseSourceMapLevels(SOURCE_MAP),
  production: parseProductionContracts(API_CONTRACTS),
}

describe('pricing evidence grades', () => {
  it('reads the highest level of each implemented source-map row', () => {
    expect(sources.levels.get('Authorization code')).toBe(3)
    expect(sources.levels.get('Audit event hash chain')).toBe(1)
  })

  it('ignores rows whose support is not implemented', () => {
    expect(sources.levels.has('Shared Signals, CAEP, RISC')).toBe(false)
  })

  it('grades a capability by its weakest row', () => {
    const grade = capabilityGrade(
      { sourceMapFeatures: ['Webhook delivery', 'Audit event hash chain'] },
      sources,
    )

    expect(grade).toBe('implemented')
  })

  it('grades local end-to-end evidence only when every row reaches L3', () => {
    const grade = capabilityGrade({ sourceMapFeatures: ['Authorization code', 'PAR'] }, sources)

    expect(grade).toBe('local-e2e')
  })

  it('grades production only from production L4 contract rows', () => {
    const grade = capabilityGrade(
      { sourceMapFeatures: [], productionContracts: [{ method: 'GET', path: '/auth/config' }] },
      sources,
    )

    expect(grade).toBe('production')
  })

  it('rejects a production claim without a production L4 row', () => {
    const claim = () =>
      capabilityGrade(
        {
          sourceMapFeatures: [],
          productionContracts: [{ method: 'POST', path: '/auth/magic-link/send' }],
        },
        sources,
      )

    expect(claim).toThrow(/not a production L4 row/)
  })

  it('rejects a feature name that is not an implemented row', () => {
    const claim = () =>
      capabilityGrade({ sourceMapFeatures: ['Shared Signals, CAEP, RISC'] }, sources)

    expect(claim).toThrow(/not an implemented row/)
  })

  it('locates the evidence row by its leading cells', () => {
    expect(findTableRowLine(SOURCE_MAP, ['PAR'])).toBe(4)
    expect(findTableRowLine(API_CONTRACTS, ['GET', '/auth/config'])).toBe(3)
  })

  it('rejects a row reference that does not exist', () => {
    const locate = () => findTableRowLine(SOURCE_MAP, ['Device flow'])

    expect(locate).toThrow(/No table row/)
  })
})

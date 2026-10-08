// 功能表的 Status 列在构建期由公开证据矩阵算出，页面源码里不写等级。
// 等级取能力所含每一行的最高档，再取各行之间的最低值：一个能力只能按最弱的那部分对外说。

export const EVIDENCE_GRADES = ['implemented', 'integration', 'local-e2e', 'production'] as const
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number]

export type ProductionContract = {
  method: string
  path: string
}

export type CapabilityEvidence = {
  sourceMapFeatures: readonly string[]
  productionContracts?: readonly ProductionContract[]
}

type TableRow = readonly string[]

function tableRows(markdown: string): TableRow[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', '')),
    )
}

function highestLevel(evidence: string): number {
  const levels = [...evidence.matchAll(/L([0-4])/g)].map((match) => Number(match[1]))
  if (levels.length === 0) throw new Error(`Evidence cell "${evidence}" has no L0-L4 level`)
  return Math.max(...levels)
}

export function parseSourceMapLevels(markdown: string): ReadonlyMap<string, number> {
  const levels = new Map<string, number>()
  for (const [feature, , support, evidence] of tableRows(markdown)) {
    if (!feature || !support || !evidence || feature === 'Feature' || /^-+$/.test(feature)) continue
    if (support !== 'implemented') continue
    levels.set(feature, highestLevel(evidence))
  }
  return levels
}

export function parseProductionContracts(markdown: string): ReadonlySet<string> {
  const verified = new Set<string>()
  for (const [method, path, status] of tableRows(markdown)) {
    if (method && path && status === 'production L4') verified.add(`${method} ${path}`)
  }
  return verified
}

// 返回首个前几列依次等于 cells 的表格行的行号（从 1 起），供链接到 GitHub 上的那一行。
export function findTableRowLine(markdown: string, cells: readonly string[]): number {
  const lines = markdown.split('\n')
  const index = lines.findIndex((line) => {
    if (!line.startsWith('|')) return false
    const [row] = tableRows(line)
    return row !== undefined && cells.every((cell, column) => row[column] === cell)
  })
  if (index === -1) throw new Error(`No table row starts with ${cells.join(' | ')}`)
  return index + 1
}

function gradeForLevel(level: number): EvidenceGrade {
  if (level >= 3) return 'local-e2e'
  if (level === 2) return 'integration'
  return 'implemented'
}

export function capabilityGrade(
  capability: CapabilityEvidence,
  sources: { levels: ReadonlyMap<string, number>; production: ReadonlySet<string> },
): EvidenceGrade {
  const contracts = capability.productionContracts ?? []
  for (const contract of contracts) {
    if (!sources.production.has(`${contract.method} ${contract.path}`)) {
      throw new Error(
        `${contract.method} ${contract.path} is not a production L4 row in docs/api-contracts.md`,
      )
    }
  }
  if (contracts.length > 0) return 'production'

  if (capability.sourceMapFeatures.length === 0) throw new Error('Capability has no evidence rows')
  const levels = capability.sourceMapFeatures.map((feature) => {
    const level = sources.levels.get(feature)
    if (level === undefined) {
      throw new Error(`"${feature}" is not an implemented row in docs/protocols/source-map.md`)
    }
    return level
  })
  return gradeForLevel(Math.min(...levels))
}

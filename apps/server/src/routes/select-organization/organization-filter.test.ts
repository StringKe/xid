import { describe, expect, it } from 'vitest'
import { filterOrganizations, VISIBLE_ORGANIZATION_LIMIT } from './organization-filter'

const org = (name: string, slug = name.toLowerCase().replace(/\s+/g, '-')) => ({ name, slug })

describe('filterOrganizations', () => {
  it('sorts by name and keeps every organization when the query is empty', () => {
    const result = filterOrganizations([org('Operations'), org('Finance'), org('Field crews')], '')

    expect(result.map((item) => item.name)).toEqual(['Field crews', 'Finance', 'Operations'])
  })

  it('matches the name or the slug without regard to case', () => {
    const result = filterOrganizations(
      [org('Northwind Logistics', 'northwind'), org('Finance')],
      'NORTH',
    )

    expect(result.map((item) => item.name)).toEqual(['Northwind Logistics'])
  })

  it('shows at most the first page of matches', () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      org(`Team ${String(index).padStart(2, '0')}`),
    )

    expect(filterOrganizations(many, '')).toHaveLength(VISIBLE_ORGANIZATION_LIMIT)
  })
})

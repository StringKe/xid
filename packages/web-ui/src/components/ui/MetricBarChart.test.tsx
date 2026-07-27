import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MetricBarChart } from './MetricBarChart'

describe('MetricBarChart', () => {
  it('renders dynamic bar metrics as inline style values', () => {
    const html = renderToStaticMarkup(
      <MetricBarChart
        title="Security rates"
        maxValue={1}
        items={[
          {
            label: 'Login success rate',
            value: 0.5,
            displayValue: '50.0%',
            tone: 'success',
          },
        ]}
      />,
    )

    expect(html).toContain('role="meter"')
    expect(html).toContain('width:50.0%')
    expect(html).toContain('background-color:var(--xid-success)')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('kzqmXN')
  })
})

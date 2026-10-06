import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders an empty list as a polite status with its explanation', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No users match Suspended"
        description="Remove a filter or search by email instead."
      />,
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('No users match Suspended')
    expect(html).toContain('Remove a filter or search by email instead.')
  })

  it('renders first use with its single primary action', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        variant="first-use"
        title="Send Northwind events to your own systems"
        action={<button type="button">Add endpoint…</button>}
      />,
    )

    expect(html).toContain('Send Northwind events to your own systems')
    expect(html).toContain('Add endpoint…')
  })

  it('renders a load failure as a warning notice instead of an empty state', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        variant="load-failure"
        title="Audit events did not load"
        description="Your filters are kept."
        action={<button type="button">Try again</button>}
      />,
    )

    expect(html).toContain('Audit events did not load')
    expect(html).toContain('Try again')
    expect(html).not.toContain('role="alert"')
  })
})

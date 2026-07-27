import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Section, SectionRow } from './Section'

describe('Section', () => {
  it('links the section element to its h2 heading via aria-labelledby', () => {
    const html = renderToStaticMarkup(
      <Section label="Identity">
        <p>Body</p>
      </Section>,
    )

    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(labelledBy).toBeTruthy()
    expect(html).toContain(`<h2 id="${labelledBy}"`)
    expect(html).toContain('Identity')
  })

  it('uses the provided labelId instead of a generated id', () => {
    const html = renderToStaticMarkup(
      <Section label="Sessions" labelId="sessions-head">
        <p>Body</p>
      </Section>,
    )

    expect(html).toContain('aria-labelledby="sessions-head"')
    expect(html).toContain('<h2 id="sessions-head"')
  })

  it('renders header actions in the head row when provided', () => {
    const html = renderToStaticMarkup(
      <Section label="Keys" actions={<button type="button">Rotate</button>}>
        <p>Body</p>
      </Section>,
    )

    const headEnd = html.indexOf('</h2>')
    const actionIndex = html.indexOf('Rotate')
    const bodyIndex = html.indexOf('Body')
    expect(actionIndex).toBeGreaterThan(headEnd)
    expect(actionIndex).toBeLessThan(bodyIndex)
  })
})

describe('SectionRow', () => {
  it('renders the action cell content only when action is provided', () => {
    const withAction = renderToStaticMarkup(
      <SectionRow label="GitHub" action={<button type="button">Disconnect</button>}>
        <p>meta</p>
      </SectionRow>,
    )
    const withoutAction = renderToStaticMarkup(
      <SectionRow label="GitHub">
        <p>meta</p>
      </SectionRow>,
    )

    expect(withAction).toContain('Disconnect')
    expect(withoutAction).not.toContain('<button')
  })

  it('wires control rows like ui/Field: label htmlFor, control id, hint aria-describedby', () => {
    const html = renderToStaticMarkup(
      <SectionRow variant="control" label="First name" hint="Shown publicly">
        <input />
      </SectionRow>,
    )

    const htmlFor = /<label for="([^"]+)"/.exec(html)?.[1]
    expect(htmlFor).toBeTruthy()
    expect(html).toContain(`id="${htmlFor}"`)
    expect(html).toContain(`aria-describedby="${htmlFor}-hint"`)
    expect(html).toContain(`id="${htmlFor}-hint"`)
  })
})

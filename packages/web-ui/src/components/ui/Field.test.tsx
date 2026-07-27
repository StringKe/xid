import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Field } from './Field'

describe('Field', () => {
  it('does not pass custom isInvalid props to native controls', () => {
    const html = renderToStaticMarkup(
      <Field label="Role" error="Required">
        <select>
          <option value="owner">Owner</option>
        </select>
      </Field>,
    )

    expect(html).toContain('aria-invalid="true"')
    expect(html).not.toContain('isInvalid')
    expect(html).not.toContain('isinvalid')
  })
})

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  BRAND_LOGO_TRANSPARENT_1X,
  BRAND_LOGO_TRANSPARENT_2X,
  BRAND_MARK_TRANSPARENT_1X,
  BRAND_MARK_TRANSPARENT_2X,
} from '../brand-assets'
import { mergeClassNames } from '../class-name'

export type BrandLogoProps = {
  variant?: 'horizontal' | 'mark'
  height?: number
  className?: string
}

const styles = stylex.create({
  img: {
    display: 'block',
    width: 'auto',
    objectFit: 'contain',
  },
})

export function BrandLogo({
  variant = 'horizontal',
  height = 28,
  className,
}: BrandLogoProps): ReactNode {
  const src = variant === 'mark' ? BRAND_MARK_TRANSPARENT_1X : BRAND_LOGO_TRANSPARENT_1X
  const srcSet =
    variant === 'mark'
      ? `${BRAND_MARK_TRANSPARENT_1X} 1x, ${BRAND_MARK_TRANSPARENT_2X} 2x`
      : `${BRAND_LOGO_TRANSPARENT_1X} 1x, ${BRAND_LOGO_TRANSPARENT_2X} 2x`
  const imgProps = stylex.props(styles.img)
  return (
    <img
      src={src}
      srcSet={srcSet}
      alt="XID"
      width={height}
      height={height}
      decoding="async"
      className={mergeClassNames(imgProps.className, className)}
      style={{ ...imgProps.style, height }}
    />
  )
}

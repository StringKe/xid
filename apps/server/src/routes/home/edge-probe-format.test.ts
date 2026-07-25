import { describe, expect, it } from 'vitest'
import {
  formatEdgeRtt,
  formatTlsLabel,
  formatVerifyMicros,
  normalizeColo,
} from './edge-probe-format'

describe('edge-probe-format', () => {
  it('normalizes colo codes', () => {
    expect(normalizeColo(' hkg ')).toBe('HKG')
    expect(normalizeColo(null)).toBeNull()
  })

  it('formats TLS version labels', () => {
    expect(formatTlsLabel('TLSv1.3')).toBe('TLS 1.3')
    expect(formatTlsLabel(null)).toBeNull()
  })

  it('formats edge RTT and verify latency', () => {
    expect(formatEdgeRtt(0.8)).toBe('0.8ms')
    expect(formatEdgeRtt(12.4)).toBe('12ms')
    expect(formatVerifyMicros(412)).toBe('412µs')
  })
})

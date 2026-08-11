// IPC 通道与 XidBridge 契约：唯一、xid: 前缀、覆盖 Shared native 表面。

import { describe, expect, it } from 'vitest'

import { IPC_CHANNELS, XID_BRIDGE_KEY } from '../types'

describe('IPC_CHANNELS', () => {
  it('all channel names are non-empty strings', () => {
    for (const value of Object.values(IPC_CHANNELS)) {
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    }
  })

  it('all channel names are unique (no duplicates)', () => {
    const values = Object.values(IPC_CHANNELS)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })

  it('all channel names are namespaced with xid: prefix', () => {
    for (const value of Object.values(IPC_CHANNELS)) {
      expect(value).toMatch(/^xid:/)
    }
  })

  it('STORAGE channels are distinct from auth channels', () => {
    const { STORAGE_SET, STORAGE_GET, STORAGE_REMOVE, SIGN_IN, SIGN_OUT, GET_ACCESS_TOKEN } =
      IPC_CHANNELS
    expect(STORAGE_SET).not.toBe(SIGN_IN)
    expect(STORAGE_GET).not.toBe(GET_ACCESS_TOKEN)
    expect(STORAGE_REMOVE).not.toBe(SIGN_OUT)
  })

  it('includes GET_ACCESS_TOKEN channel (Shared native contract getAccessToken)', () => {
    expect(IPC_CHANNELS.GET_ACCESS_TOKEN).toBeDefined()
    expect(typeof IPC_CHANNELS.GET_ACCESS_TOKEN).toBe('string')
  })

  it('includes GET_SESSION channel (Shared native contract getSession)', () => {
    expect(IPC_CHANNELS.GET_SESSION).toBeDefined()
    expect(typeof IPC_CHANNELS.GET_SESSION).toBe('string')
  })

  it('includes SET_TOKEN_STORAGE channel (Shared native contract setTokenStorage)', () => {
    expect(IPC_CHANNELS.SET_TOKEN_STORAGE).toBeDefined()
    expect(typeof IPC_CHANNELS.SET_TOKEN_STORAGE).toBe('string')
  })
})

describe('XID_BRIDGE_KEY', () => {
  it('equals xidBridge', () => {
    expect(XID_BRIDGE_KEY).toBe('xidBridge')
  })

  it('is a non-empty string', () => {
    expect(typeof XID_BRIDGE_KEY).toBe('string')
    expect(XID_BRIDGE_KEY.length).toBeGreaterThan(0)
  })
})

describe('XidBridge Shared native contract surface', () => {
  // 无 Electron 时以 IPC_CHANNELS 与类型契约对齐。

  it('has a SIGN_IN channel covering signIn()', () => {
    expect(IPC_CHANNELS.SIGN_IN).toBeDefined()
  })

  it('has a SIGN_OUT channel covering signOut()', () => {
    expect(IPC_CHANNELS.SIGN_OUT).toBeDefined()
  })

  it('has a GET_ACCESS_TOKEN channel covering getAccessToken()', () => {
    expect(IPC_CHANNELS.GET_ACCESS_TOKEN).toBeDefined()
  })

  it('has a GET_SESSION channel covering getSession()', () => {
    expect(IPC_CHANNELS.GET_SESSION).toBeDefined()
  })

  it('has a SET_TOKEN_STORAGE channel covering setTokenStorage()', () => {
    expect(IPC_CHANNELS.SET_TOKEN_STORAGE).toBeDefined()
  })
})

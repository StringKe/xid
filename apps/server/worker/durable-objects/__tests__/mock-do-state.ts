// mock-do-state.ts:DurableObjectState 内存实现,供单元测试使用。
// 只实现测试用到的 storage KV + alarm 接口,未用接口抛 Not Implemented。

type AlarmHandler = () => Promise<void>

class MockDurableObjectStorage {
  private data = new Map<string, unknown>()
  private alarmTime: number | null = null
  private alarmHandler: AlarmHandler | null = null

  setAlarmHandler(handler: AlarmHandler): void {
    this.alarmHandler = handler
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }

  async delete(key: string | string[]): Promise<number> {
    if (Array.isArray(key)) {
      let count = 0
      for (const k of key) {
        if (this.data.delete(k)) count++
      }
      return count
    }
    return this.data.delete(key) ? 1 : 0
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.data) as Map<string, T>
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmTime = scheduledTime
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null
  }

  // 测试辅助:触发 alarm
  async triggerAlarm(): Promise<void> {
    if (this.alarmHandler !== null) {
      this.alarmTime = null
      await this.alarmHandler()
    }
  }

  // 测试辅助:查看 storage 大小
  size(): number {
    return this.data.size
  }

  // sql stub:未使用
  get sql(): never {
    throw new Error('sql not implemented in mock')
  }
}

export class MockDurableObjectState {
  readonly storage: MockDurableObjectStorage

  constructor() {
    this.storage = new MockDurableObjectStorage()
  }

  // 注册 alarm 触发时调用的 handler(指向 DO 实例的 alarm 方法)
  setAlarmHandler(handler: AlarmHandler): void {
    this.storage.setAlarmHandler(handler)
  }

  // 触发 alarm
  async triggerAlarm(): Promise<void> {
    await this.storage.triggerAlarm()
  }

  // 未使用的 DurableObjectState 接口 stubs
  get id(): never {
    throw new Error('not implemented')
  }
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }
  acceptWebSocket(): never {
    throw new Error('not implemented')
  }
  getWebSockets(): never {
    throw new Error('not implemented')
  }
  setWebSocketAutoResponse(): never {
    throw new Error('not implemented')
  }
  getWebSocketAutoResponse(): never {
    throw new Error('not implemented')
  }
  getWebSocketAutoResponseTimestamp(): never {
    throw new Error('not implemented')
  }
  setHibernatableWebSocketEventTimeout(): never {
    throw new Error('not implemented')
  }
  getHibernatableWebSocketEventTimeout(): never {
    throw new Error('not implemented')
  }
  getTags(): never {
    throw new Error('not implemented')
  }
  waitUntil(): never {
    throw new Error('not implemented')
  }
}

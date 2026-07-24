import Foundation

actor RefreshSingleFlight<Value: Sendable> {
    private var task: Task<Value, Error>?

    /// 已并入当前 in-flight 操作的调用数。注册新操作时归零。
    /// 去重是本类型的并发契约,必须可从外部观测,否则调用方(含测试)
    /// 只能靠调度时序推断「第二个调用是否并入」,那是不确定的。
    private(set) var joinCount = 0

    func run(operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        // 从这里的读取到下面的 self.task = task 之间没有 await 挂起点,
        // 整段在同一次 actor-isolated 同步执行里完成,check-and-register 因此是原子的。
        if let task {
            joinCount += 1
            return try await task.value
        }

        let task = Task(operation: operation)
        self.task = task
        joinCount = 0
        defer {
            // 只清自己登记的那个操作,避免清掉后来者。Task 是 struct,身份比较用 == 不是 ===。
            if self.task == task {
                self.task = nil
            }
        }
        return try await task.value
    }

    func valueIfRunning() async throws -> Value? {
        guard let task else {
            return nil
        }
        joinCount += 1
        return try await task.value
    }
}

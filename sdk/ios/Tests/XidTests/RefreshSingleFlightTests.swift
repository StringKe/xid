import XCTest
@testable import Xid

final class RefreshSingleFlightTests: XCTestCase {
    func testConcurrentCallsShareOneOperation() async throws {
        let singleFlight = RefreshSingleFlight<Int>()
        let counter = RefreshCounter()
        let gate = RefreshGate()

        async let first = singleFlight.run {
            let value = await counter.refresh()
            await gate.startAndWait()
            return value
        }
        await gate.waitUntilStarted()
        let second = Task {
            try await singleFlight.run {
                await counter.refresh()
            }
        }
        // 创建子任务只保证「已创建」,不保证「已进入 actor」。
        // 必须等第二个调用真正并入 in-flight 操作再放行 gate,
        // 否则第一个操作可能先完成并注销自己,测的就成了调度时序而不是去重。
        await waitUntilJoined(singleFlight)

        await gate.release()
        let values = try await [first, second.value]
        XCTAssertEqual(values, [1, 1])
        let count = await counter.currentCount()
        XCTAssertEqual(count, 1)
    }

    func testFailureClearsInFlightOperationForRetry() async throws {
        let singleFlight = RefreshSingleFlight<Int>()
        let attempts = RefreshAttempts()

        do {
            _ = try await singleFlight.run {
                try await attempts.run()
            }
            XCTFail("Expected the first refresh to fail")
        } catch {
            XCTAssertEqual(error as? RefreshTestError, .failed)
        }

        let value = try await singleFlight.run {
            try await attempts.run()
        }
        XCTAssertEqual(value, 2)
        let count = await attempts.currentCount()
        XCTAssertEqual(count, 2)
    }

    func testPendingConsumerWaitsForRunningOperation() async throws {
        let singleFlight = RefreshSingleFlight<Int>()
        let gate = RefreshGate()

        async let refresh = singleFlight.run {
            await gate.startAndWait()
            return 7
        }
        await gate.waitUntilStarted()
        let pending = Task {
            try await singleFlight.valueIfRunning()
        }
        await waitUntilJoined(singleFlight)

        await gate.release()
        let refreshValue = try await refresh
        let pendingValue = try await pending.value
        XCTAssertEqual(refreshValue, 7)
        XCTAssertEqual(pendingValue, 7)
    }
}

/// 自旋等到第二个调用确实并入 in-flight 操作。
/// 正常路径必然结束:第一个操作被 gate 挡住不会完成,登记不会被清,
/// 第二个任务一旦被调度就必然走 join 分支把 joinCount 变成 1。
/// 设上限是为了让「去重被改坏」表现为一条明确的断言失败,而不是把 CI job 挂死。
private func waitUntilJoined(
    _ singleFlight: RefreshSingleFlight<Int>,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    for _ in 0 ..< 100_000 {
        if await singleFlight.joinCount > 0 {
            return
        }
        await Task.yield()
    }
    XCTFail("并发调用没有并入 in-flight 操作,single-flight 去重已失效", file: file, line: line)
}

private actor RefreshCounter {
    private(set) var count = 0

    func refresh() -> Int {
        count += 1
        return count
    }

    func currentCount() -> Int {
        count
    }
}

private actor RefreshAttempts {
    private(set) var count = 0

    func run() throws -> Int {
        count += 1
        if count == 1 {
            throw RefreshTestError.failed
        }
        return count
    }

    func currentCount() -> Int {
        count
    }
}

private actor RefreshGate {
    private var didStart = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func startAndWait() async {
        didStart = true
        let waiters = startWaiters
        startWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
        await withCheckedContinuation { continuation in
            releaseWaiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        if didStart {
            return
        }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func release() {
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private enum RefreshTestError: Error {
    case failed
}

namespace Xid;

/// <summary>
/// 多实例部署场景下的 JWKS 外部缓存协议(Redis / Memcached 等)。
/// 进程间共享 JWKS 快照,避免每个实例独立击穿源站。
/// </summary>
public interface IJwksExternalCache
{
    /// <summary>读取缓存的 JWKS JSON 字符串;未命中返回 null。</summary>
    Task<string?> GetAsync(string key, CancellationToken ct = default);

    /// <summary>写入 JWKS JSON,TTL 与 <see cref="JwksCache"/> 配置对齐。</summary>
    Task SetAsync(string key, string value, TimeSpan ttl, CancellationToken ct = default);
}
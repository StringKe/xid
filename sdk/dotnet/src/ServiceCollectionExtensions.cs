// ASP.NET Core 依赖注入扩展
//
// 提供 IServiceCollection.AddXid() 便捷注册方式。
// 调用方只需在 Program.cs / Startup.cs 添加一行:
//   builder.Services.AddXid(options => { options.Issuer = "https://xid.dev"; });
//
// XidClient 注册为 Singleton:内部 JwksCache / HttpClient 线程安全,
// 跨请求复用缓存减少 JWKS 源站压力。

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Xid;

/// <summary>
/// ASP.NET Core 依赖注入集成扩展方法。
/// </summary>
public static class ServiceCollectionExtensions
{
    /// <summary>
    /// 注册 <see cref="XidClient"/> 为 Singleton。
    /// </summary>
    /// <param name="services">服务容器</param>
    /// <param name="configureOptions">配置回调</param>
    /// <param name="configureHttpClient">可选:自定义拉取 JWKS 用的 HttpClient</param>
    public static IServiceCollection AddXid(
        this IServiceCollection services,
        Action<XidOptions> configureOptions,
        Action<IHttpClientBuilder>? configureHttpClient = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configureOptions);

        var options = new XidOptions { Issuer = string.Empty };  // 临时占位,下行覆盖
        configureOptions(options);

        // 注册带 IHttpClientFactory 的 HttpClient,便于 resilience/retry 策略接入
        var httpClientBuilder = services.AddHttpClient<XidClient>(client =>
        {
            client.Timeout = TimeSpan.FromSeconds(10);
        });
        configureHttpClient?.Invoke(httpClientBuilder);

        services.TryAddSingleton(options);
        services.TryAddSingleton(sp =>
        {
            var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
            var httpClient = httpClientFactory.CreateClient(nameof(XidClient));
            return new XidClient(options, httpClient);
        });

        return services;
    }
}

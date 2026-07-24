// DpapiTokenStorage.cs
// XID Windows SDK
//
// 默认 token 存储实现:DPAPI (ProtectedData.Protect) + IsolatedStorage。
// Windows 专属 API 限定在 WINDOWS 编译条件内。
// 非 Windows 平台只看到类型定义,ProtectedData 不被引用。
//
// 存储策略:
//   - token JSON 序列化后用 DPAPI 加密 (CurrentUser scope),
//     密文写入 IsolatedStorage (应用隔离,不共享给其他用户或其他应用)。
//   - DPAPI 密钥与当前 Windows 用户账号绑定,用户切换或账号删除后密文不可解密。
//   - 不存 client secret:Windows 桌面应用是 public client。

using System.IO.IsolatedStorage;
using System.Text;
using System.Text.Json;

#if WINDOWS
using System.Security.Cryptography;
#endif

namespace Xid.Windows;

/// <summary>
/// 基于 DPAPI + IsolatedStorage 的 token 安全存储。
/// 仅在 Windows 运行时可用;其他平台请替换为自定义 <see cref="ITokenStorage"/> 实现。
/// </summary>
public sealed class DpapiTokenStorage : ITokenStorage
{
    private const string FileName = "xid_tokens.bin";

    // DPAPI 附加熵,增加暴力破解难度,与应用绑定
    private static readonly byte[] Entropy =
        Encoding.UTF8.GetBytes("xid-windows-sdk-entropy-v1");

    private readonly SemaphoreSlim _lock = new(1, 1);

    /// <inheritdoc />
    public async Task SaveAsync(StoredTokenSet tokens, CancellationToken ct = default)
    {
#if !WINDOWS
        throw new PlatformNotSupportedException("DpapiTokenStorage 仅支持 Windows 平台。请在非 Windows 平台提供自定义 ITokenStorage 实现。");
#else
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(tokens);
        byte[] encrypted = ProtectedData.Protect(json, Entropy, DataProtectionScope.CurrentUser);

        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await WriteIsolatedAsync(encrypted, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new TokenStorageException("写入安全存储失败。", ex);
        }
        finally
        {
            _lock.Release();
        }
#endif
    }

    /// <inheritdoc />
    public async Task<StoredTokenSet?> LoadAsync(CancellationToken ct = default)
    {
#if !WINDOWS
        throw new PlatformNotSupportedException("DpapiTokenStorage 仅支持 Windows 平台。请在非 Windows 平台提供自定义 ITokenStorage 实现。");
#else
        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            byte[]? encrypted = await ReadIsolatedAsync(ct).ConfigureAwait(false);
            if (encrypted is null) return null;

            byte[] json = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<StoredTokenSet>(json);
        }
        catch (CryptographicException ex)
        {
            // DPAPI 解密失败通常意味着文件在其他账号下写入或文件已损坏
            throw new TokenStorageException("token 解密失败,可能是账号变更或文件损坏。", ex);
        }
        catch (Exception ex)
        {
            throw new TokenStorageException("读取安全存储失败。", ex);
        }
        finally
        {
            _lock.Release();
        }
#endif
    }

    /// <inheritdoc />
    public async Task ClearAsync(CancellationToken ct = default)
    {
#if !WINDOWS
        throw new PlatformNotSupportedException("DpapiTokenStorage 仅支持 Windows 平台。请在非 Windows 平台提供自定义 ITokenStorage 实现。");
#else
        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            using var store = IsolatedStorageFile.GetUserStoreForAssembly();
            if (store.FileExists(FileName))
                store.DeleteFile(FileName);
        }
        catch (Exception ex)
        {
            throw new TokenStorageException("清除安全存储失败。", ex);
        }
        finally
        {
            _lock.Release();
        }
#endif
    }

    // -- 内部 IsolatedStorage 辅助 --

    private static async Task WriteIsolatedAsync(byte[] data, CancellationToken ct)
    {
        using var store = IsolatedStorageFile.GetUserStoreForAssembly();
        using var stream = new IsolatedStorageFileStream(
            FileName, FileMode.Create, FileAccess.Write, store);
        await stream.WriteAsync(data, ct).ConfigureAwait(false);
    }

    private static async Task<byte[]?> ReadIsolatedAsync(CancellationToken ct)
    {
        using var store = IsolatedStorageFile.GetUserStoreForAssembly();
        if (!store.FileExists(FileName)) return null;

        using var stream = new IsolatedStorageFileStream(
            FileName, FileMode.Open, FileAccess.Read, store);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        return ms.ToArray();
    }
}

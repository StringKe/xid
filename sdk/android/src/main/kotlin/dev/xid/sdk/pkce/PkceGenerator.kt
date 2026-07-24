package dev.xid.sdk.pkce

/**
 * PKCE S256 code verifier / code challenge 生成器。
 *
 * 规范: RFC 7636。
 * - code_verifier: 43~128 字符的随机 URL-safe 字符串。
 * - code_challenge: BASE64URL(SHA-256(ASCII(code_verifier)))。
 * - code_challenge_method: "S256"(本 SDK 仅支持 S256, 拒绝 plain)。
 *
 * 算法实现委托给 [PkceCore](使用 java.util.Base64, 纯 JDK, 可在 JVM 单元测试直接调用)。
 * [java.util.Base64.getUrlEncoder] 与 android.util.Base64(URL_SAFE|NO_WRAP|NO_PADDING)
 * 输出等价, 无行为差异。
 */
internal object PkceGenerator {

    /** code_challenge_method 固定为 S256。*/
    const val METHOD = "S256"

    /**
     * 生成一对 PKCE 参数。
     *
     * @return [PkcePair] 包含 code_verifier 和对应的 code_challenge(S256)。
     */
    fun generate(): PkcePair {
        val verifier = PkceCore.generateVerifier()
        val challenge = PkceCore.deriveChallenge(verifier)
        return PkcePair(verifier = verifier, challenge = challenge)
    }

    /**
     * 派生 code_challenge: BASE64URL(SHA-256(ASCII(verifier)))。
     * 委托给 [PkceCore.deriveChallenge]。
     *
     * @param verifier code_verifier 字符串(纯 ASCII)。
     */
    internal fun deriveChallenge(verifier: String): String = PkceCore.deriveChallenge(verifier)
}

/**
 * PKCE 参数对。
 *
 * @param verifier  code_verifier, 在 /token 端点交换时传入。
 * @param challenge code_challenge(S256), 在 /authorize 请求时传入。
 */
internal data class PkcePair(
    val verifier: String,
    val challenge: String,
)

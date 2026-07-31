#!/bin/bash
# XID Java SDK - compile and test using javac + java (no Maven required)
#
# Usage:  bash compile.sh
# Requires: JDK 17+ (tested with JDK 25)
#
# No third-party dependencies. All crypto via java.security / javax.crypto.

set -euo pipefail

JAVAC="${JAVA_HOME:+${JAVA_HOME}/bin/}javac"
JAVA="${JAVA_HOME:+${JAVA_HOME}/bin/}java"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_MAIN="${SCRIPT_DIR}/src/main/java"
SRC_TEST="${SCRIPT_DIR}/src/test/java"
OUT="${SCRIPT_DIR}/target/classes"
OUT_TEST="${SCRIPT_DIR}/target/test-classes"

echo "=== XID Java SDK: compile.sh ==="
echo "JDK: $("${JAVA}" -version 2>&1 | head -1)"

# Clean
rm -rf "${SCRIPT_DIR}/target"
mkdir -p "${OUT}" "${OUT_TEST}"

# Collect main sources
MAIN_SOURCES=(
    "${SRC_MAIN}/dev/xid/sdk/XidException.java"
    "${SRC_MAIN}/dev/xid/sdk/XidTokenException.java"
    "${SRC_MAIN}/dev/xid/sdk/XidJwksException.java"
    "${SRC_MAIN}/dev/xid/sdk/XidSessionTokenExchangeException.java"
    "${SRC_MAIN}/dev/xid/sdk/XidWebhookException.java"
    "${SRC_MAIN}/dev/xid/sdk/JsonParser.java"
    "${SRC_MAIN}/dev/xid/sdk/XidClaims.java"
    "${SRC_MAIN}/dev/xid/sdk/JwksCache.java"
    "${SRC_MAIN}/dev/xid/sdk/TokenVerifier.java"
    "${SRC_MAIN}/dev/xid/sdk/WebhookVerifier.java"
    "${SRC_MAIN}/dev/xid/sdk/XidClientOptions.java"
    "${SRC_MAIN}/dev/xid/sdk/AuthResult.java"
    "${SRC_MAIN}/dev/xid/sdk/SessionTokenHttpResponse.java"
    "${SRC_MAIN}/dev/xid/sdk/SessionTokenTransport.java"
    "${SRC_MAIN}/dev/xid/sdk/XidClient.java"
)

echo ""
echo "--- Compiling main sources ---"
"${JAVAC}" --release 17 \
    -encoding UTF-8 \
    -d "${OUT}" \
    "${MAIN_SOURCES[@]}"
echo "Main compile: OK"

# Collect test sources
TEST_SOURCES=(
    "${SRC_TEST}/dev/xid/sdk/JsonParserTest.java"
    "${SRC_TEST}/dev/xid/sdk/TokenVerifierTest.java"
    "${SRC_TEST}/dev/xid/sdk/WebhookVerifierTest.java"
    "${SRC_TEST}/dev/xid/sdk/RequestAuthContractTest.java"
)

echo ""
echo "--- Compiling test sources ---"
"${JAVAC}" --release 17 \
    -encoding UTF-8 \
    -cp "${OUT}" \
    -d "${OUT_TEST}" \
    "${TEST_SOURCES[@]}"
echo "Test compile: OK"

# Run tests
CP="${OUT}:${OUT_TEST}"
echo ""
echo "--- Running tests ---"
TOTAL_PASSED=0
TOTAL_FAILED=0

run_test() {
    local class="$1"
    local output
    local rc=0
    output=$("${JAVA}" -ea -cp "${CP}" "${class}" 2>&1) || rc=$?
    echo "${output}"
    if [ "${rc}" -ne 0 ]; then
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    else
        # Count passed from output
        local p
        p=$(echo "${output}" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || true)
        TOTAL_PASSED=$((TOTAL_PASSED + ${p:-0}))
    fi
}

run_test "dev.xid.sdk.JsonParserTest"
run_test "dev.xid.sdk.TokenVerifierTest"
run_test "dev.xid.sdk.WebhookVerifierTest"
run_test "dev.xid.sdk.RequestAuthContractTest"

echo ""
echo "=== SUMMARY ==="
echo "Total test classes run: 4"
if [ "${TOTAL_FAILED}" -eq 0 ]; then
    echo "All tests PASSED"
    exit 0
else
    echo "FAILED test classes: ${TOTAL_FAILED}"
    exit 1
fi

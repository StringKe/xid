## What changed

<!-- What this does and why. Link the design decision in docs/design/ if behavior changes. -->

## Related issues

<!-- Closes #123 / Refs #123 -->

## Type of change

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] refactor
- [ ] perf
- [ ] test
- [ ] build / ci / chore
- [ ] Breaking change (describe the migration path below)

## Checklist

- [ ] All commits are signed off (`git commit -s`, DCO 1.1)
- [ ] Commit messages follow Conventional Commits 1.0.0
- [ ] `pnpm run check` passes locally
- [ ] `pnpm test` passes locally
- [ ] Tests added or updated for protocol correctness, tenant isolation, cryptographic paths, or
      concurrency semantics if any of those were touched
- [ ] UI strings changed: ran `pnpm run i18n:extract` and `pnpm run i18n:compile`, catalogs committed
- [ ] Native SDK changed: ran `XID_NATIVE_SDK_PLATFORM=<platform> node --test tests/native-sdk-contract.test.mjs`
- [ ] Documentation updated (`docs/design/`, `docs/protocols/`, or `docs/sdks/`) if behavior changed
- [ ] No secrets, `.env` files, real tokens, private keys, or real tenant data in the diff
- [ ] AI configuration edited at the source in `.stdai/standards/`, not in generated files

## Breaking change / migration notes

<!-- Delete if not applicable. -->

# Support

XID is maintained as an open source project. Community support is best-effort with no service level
agreement. This file is the project’s public map for **how to get help, report bugs, request
enhancements, and contribute**.

## Where to go

| Need                                    | Channel                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Security vulnerability                  | [`SECURITY.md`](SECURITY.md). **Never** a public issue. Prefer GitHub private vulnerability reporting. |
| Bug report                              | [New issue](https://github.com/StringKe/xid/issues/new/choose) using the **bug** template          |
| Protocol or specification conformance   | Issues, **protocol conformance** template                                                        |
| Feature / enhancement request           | Issues, **feature request** template, or [Discussions](https://github.com/StringKe/xid/discussions) |
| Question, integration help, design idea | [Discussions](https://github.com/StringKe/xid/discussions)                                       |
| Contributing a change                   | [`CONTRIBUTING.md`](CONTRIBUTING.md) (pull requests + DCO)                                        |
| Code of conduct                         | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)                                                       |

Public issue and discussion history is the searchable archive of reports and replies:
https://github.com/StringKe/xid/issues

## Before opening an issue

Check the documentation. Most integration questions are answered there:

- `docs/design/README.md` -> product design truth source, 9 chapters
- `docs/protocols/README.md` -> protocol matrices; `docs/protocols/source-map.md` maps each protocol
  requirement to its implementation; `docs/protocols/gap-audit.md` lists known gaps
- `docs/sdks/platform-matrix.md` -> SDK status per platform
- `docs/api-contracts.md` -> Management API contracts
- `docs/deployment.md` -> deployment and Cloudflare bindings

Then:

1. Search existing issues and discussions.
2. Confirm the behavior against the latest commit on `main`.
3. Check `docs/protocols/gap-audit.md`. Some behavior is documented as not yet implemented rather
   than broken.

## Support expectations

Nothing in this repository is production-supported. Verification against real external identity
providers and downstream systems is incomplete. Support levels follow the L0-L4 evidence tiers
defined in `docs/protocols/` and `docs/sdks/platform-matrix.md`; those documents are authoritative.

Commercial support for the hosted service at [xid.dev](https://xid.dev) is separate from this
repository and is not covered by community channels.

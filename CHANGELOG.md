# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `POST /v1/chat/completions` streaming carries a non-standard `diagnostics` object on the final chunk (`protocolShape`, `protocolTruncated`, character counts, call count, retry flags), so local clients can log the parse verdict per turn instead of asking maintainers to decompress session logs.

## [0.2.0] - 2026-10-20

### Added

- `GET /health` now lists `capabilities`, a machine-checkable feature floor (`dsml-tool-calls`, `protocol-switches`, `truncated-retry`, `live-reasoning`, `include-usage`, `health-self-description`) that local clients assert against instead of trusting `version`.

- Parse DeepSeek Web's native DSML tool-call markup, including the marker-stripped tag shapes returned by the private endpoint, into structured `tool_calls` and Responses `function_call` items.
- `DS_TOOLS` selects the protocol wording sent to the model: `text` (default, JSON blocks) or `native` (DeepSeek markup). Both shapes are always parsed back into structured calls.
- Live thinking for tool-compatible turns: reasoning deltas reach the client as they arrive, while the final answer and structured calls are emitted once the protocol text is resolved.
- `GET /health` now also reports `version`, the effective `toolReasoning`/`toolCalls` switches, and the age of the stored credential snapshot, so a client that reuses an already-listening process can tell a stale build from a current one.
- `POST /v1/chat/completions` streaming honors `stream_options.include_usage` by attaching the upstream accumulated output token counter to the final chunk.

### Changed

- A tool turn whose protocol text cannot be parsed now counts as an unusable response and takes the same single automatic retry as an empty turn, instead of returning raw markup as the answer.
- Version bumped to `0.2.0` so a client can compare `GET /health` `version` against a floor; the capability list stays the primary contract because a reused process may be running an untagged build.

## [0.1.0] - 2026-07-25

### Added

- Local OpenAI-compatible `POST /v1/responses` and `POST /v1/chat/completions` endpoints with streaming and non-streaming modes.
- Chrome/CDP login bootstrap, reusable auth snapshots, DeepSeek Web PoW solving, and persistent session lineage.
- Reasoning/output mapping, prompt-based function-call compatibility, Web search toggling, API-key protection, and model discovery.
- Pi integration guidance for both `openai-completions` and `openai-responses`.
- CI, contributor/security policy, architecture/API documentation, and release metadata.

### Security

- Loopback binding by default and owner-only runtime credential files.
- Runtime credentials, sessions, API keys, and Chrome profiles excluded from Git.

[Unreleased]: https://github.com/kittors/deepseek-web-api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kittors/deepseek-web-api/releases/tag/v0.1.0

# API compatibility

The server implements a practical text-only subset of OpenAI's Responses API and Chat Completions API. It is designed for common OpenAI-compatible clients, but it does not claim complete wire or behavioral parity with OpenAI.

Base URL:

```text
http://127.0.0.1:8787/v1
```

## Authentication

Every `/v1/*` request requires one of:

```http
Authorization: Bearer <api-key>
```

```http
x-api-key: <api-key>
```

`GET /health` is intentionally unauthenticated. The API key comes from `DS_API_KEY`, `DS_API_KEY_FILE`, or the generated `data/.api-key` file.

It answers with the running build and the switches that local clients (the DSH plugin) must match, so a process left over from an older build cannot silently reintroduce fixed behavior:

```json
{
  "ok": true,
  "version": "0.2.0",
  "toolReasoning": "clean",
  "toolCalls": "text",
  "streamContent": "buffered",
  "authReady": true,
  "authAgeMs": 123456,
  "capabilities": [
    "dsml-tool-calls",
    "protocol-switches",
    "truncated-retry",
    "live-reasoning",
    "include-usage",
    "health-self-description",
    "live-tool-content"
  ]
}
```

`capabilities` is a machine-checkable feature floor. Local clients (the DSH plugin) assert against it rather than trusting `version`, because a process left listening from an older build silently reintroduces fixed behavior — and releases here do not always bump the version. Adding a capability is a deliberate act: only list behavior this build guarantees unconditionally.

`streamContent` reports the effective answer-streaming mode, and unlike the capabilities above it is a setting rather than a guarantee: `live-tool-content` says this build *can* release tool-turn prose early once `DS_STREAM_CONTENT=live` is set.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/responses` | Responses API compatible text response |
| `POST` | `/v1/chat/completions` | Chat Completions compatible text response |
| `GET` | `/v1/models` | Public model aliases |
| `GET` | `/health` | Process health plus the build and protocol switches; does not probe DeepSeek on every call |

## Models

| Public ID | Aliases | DeepSeek Web `model_type` | Search |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | `flash`, `default`, `deepseek-chat` | `default` | supported |
| `deepseek-v4-pro` | `pro`, `expert`, `deepseek-reasoner` | `expert` | forced off |

Unknown model strings containing `pro` or `expert` resolve to expert mode; other unknown strings resolve to flash mode. Clients should use the two public IDs returned by `/v1/models`.

### Measured context ceiling

This proxy enforces no context limit of its own (only the 16 MiB request body cap in `src/server/routes.ts`), so the ceiling is the web model's. Measured on 2026-10-21 by planting random needles at 2%/25%/50%/75%/98% of a filler prompt against `deepseek-v4-flash`:

| Prompt | Upstream accumulated tokens | Result |
| --- | --- | --- |
| 1,850,168 Chinese characters (4.22 MB UTF-8) | 957,921 | all five needles recovered |
| 1,900,163 characters (4.33 MB) | 0 | silent empty turn |
| 2,400,179 characters (5.47 MB) | 0 | silent empty turn, reproducible |

So the window is the advertised ~1M tokens, and this text converts at 0.518 tokens per character. Note that `usage.completion_tokens` carries the upstream *accumulated* counter, not just the reply: with `prompt_tokens` pinned at 0 it is the only token reading the web endpoint exposes, and it is what the table above is measured against.

An oversized turn is **not** reported as an HTTP error. The upstream answers `200 text/event-stream` with a single empty delta and `finish_reason: "stop"`, which is indistinguishable from a successful empty reply, so `assertTextTurnProduced` (`src/deepseek/streamWatch.ts`) raises the attributed failure for text turns too, and past `OVERSIZED_PROMPT_MIN_TOKENS` that failure is a `413` whose wording the DSH plugin maps to the non-retryable `CONTEXT_WINDOW_EXCEEDED`. See [Errors](#errors).

## Responses API

### Commonly supported request fields

| Field | Behavior |
| --- | --- |
| `model` | Resolves to flash/default or pro/expert. |
| `input` | String, message array, Responses message items, `function_call`, and `function_call_output` text history. |
| `instructions` / `system` | Included in the compatibility prompt. |
| system/developer input messages | Included as instructions and restated on every turn. |
| `stream` | `true` returns SSE; otherwise returns one completed response object. |
| `reasoning.effort`, `reasoning_effort`, `thinking_level` | Mapped to DeepSeek's boolean thinking switch. `none`, `off`, `0`, `false`, and `disabled` turn it off. |
| `thinking_enabled`, `reasoning_enabled` | Direct boolean compatibility fields. |
| `tools` | Function definitions are prompt-injected. A tool whose type contains `web` or `search` also enables DeepSeek Web search in flash mode. |
| `tool_choice`, `parallel_tool_calls` | Expressed in the compatibility prompt; not enforced by a native upstream tool API. |
| `previous_response_id` | Continues a persisted DeepSeek session when it is an ID issued by this adapter. |
| `conversation`, `chat_session_id`, metadata conversation IDs | Explicit local continuation hints. |

Responses `reasoning` items replayed by clients are treated as assistant-internal state and are not converted into user turns. Assistant `message`, `function_call`, and `function_call_output` items remain part of the matching history.

### Accepted but not implemented as OpenAI features

Unknown JSON fields are generally ignored rather than rejected. Fields such as `store`, `include`, `temperature`, `top_p`, `max_output_tokens`, `service_tier`, `prompt_cache_key`, `background`, `truncation`, and text-format controls do not currently change the DeepSeek Web request.

This leniency helps SDKs that send standard defaults, but clients must not assume those controls are honored.

### Non-streaming response

A completed object contains:

- `id`, `object: "response"`, `created_at`, `status`, and `model`
- `output`: optional `reasoning`, assistant `message`, and/or `function_call` items
- `output_text`: final visible assistant text
- `usage`: upstream output token count; input tokens are `0`
- `metadata.chat_session_id`: local continuation identifier
- `metadata.request_message_id` and `metadata.response_message_id`: upstream lineage diagnostics
- optional `title` from the DeepSeek stream

Example:

```json
{
  "id": "resp_<session-id>",
  "object": "response",
  "status": "completed",
  "model": "deepseek-v4-flash",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "Hello" }]
    }
  ],
  "output_text": "Hello",
  "usage": { "input_tokens": 0, "output_tokens": 1, "total_tokens": 1 },
  "metadata": { "chat_session_id": "<session-id>" }
}
```

See [responses-api.md](responses-api.md) for the event sequence and function-call details.

## Chat Completions

### Commonly supported request fields

| Field | Behavior |
| --- | --- |
| `model` | Same model resolver as Responses. |
| `messages` | `system`, `developer`, `user`, `assistant`, `tool`, and `function` text history. |
| `stream` | `true` returns `chat.completion.chunk` SSE frames followed by `[DONE]`. |
| `stream_options.include_usage` | `true` attaches `usage` to the final streaming chunk; usage is omitted otherwise. |
| `tools` / `functions` | Prompt-based tool compatibility. |
| `tool_choice` / `function_call` | Included in the compatibility prompt. |
| reasoning/thinking compatibility fields | Mapped to the upstream boolean thinking switch. |
| `conversation`, `chat_session_id`, `previous_response_id` | Session continuation hints. |

`temperature`, token limits, penalties, stop sequences, logprobs, response formats, seed, and other sampling fields are currently accepted but not applied upstream.

### Non-streaming response

Normal text appears in `choices[0].message.content`. Reasoning appears in the widely used non-standard `choices[0].message.reasoning_content` field. Parsed calls appear in `choices[0].message.tool_calls` with `finish_reason: "tool_calls"`.

The response also includes:

- `conversation`: DeepSeek session ID
- `previous_response_id`: Responses-style continuation handle

### Streaming response

Text chunks use:

```json
{
  "choices": [{
    "index": 0,
    "delta": { "content": "..." },
    "finish_reason": null
  }]
}
```

Reasoning chunks use `delta.reasoning_content`. Tool calls use `delta.tool_calls`, and the final chunk sets `finish_reason` to `tool_calls` or `stop`.

Tool-turn answer text is buffered by default: `delta.content` for a turn that calls a tool arrives once, after the protocol text has been parsed (`DS_STREAM_CONTENT=buffered`). `DS_STREAM_CONTENT=live` instead releases prose through the same gate that guards reasoning, so the answer types out while the model is still writing. The gate only ever holds text back and never retracts what it released, so markup cannot appear, and the post-parse emission sends only the tail the client has not seen yet. Live mode applies to the first attempt of a turn: if that attempt is judged unusable and retried, the retry's verdict replaces it and nothing is appended, because SSE text already on screen cannot be taken back.

The final chunk also carries a non-standard `diagnostics` object describing what the authoritative parser concluded: `protocolShape` (`dsml` / `json` / `none`), `protocolTruncated`, `reasoningChars`, `outputChars`, `toolCallCount`, and the empty/retry flags. It exists so a local client can log one line per turn and answer "why did this turn not call anything" without decompressing a session log.

When both channels came back empty, `diagnostics` additionally carries `emptyVerdict` plus `streamEvidence`
(`events`, `sawReady`, `sawClose`, `droppedContentFrames`). The verdict is decided from what the upstream
actually sent, never from prompt size:

| verdict | meaning | who to blame |
|---|---|---|
| `upstream-not-started` | no `ready` frame ever arrived | the upstream never accepted the turn |
| `upstream-silent` | a reply was opened, then produced no reasoning and no answer text | upstream availability |
| `parser-dropped-content` | frames held answer-shaped text that yielded no delta | our normalizer; fix the parser |

Attribution matters because a turn is only retried once: with a verdict the server raises a real failure
(`504` for a silent reply, `502` for one that never started) instead of writing an apology into the
assistant text, which previously made the turn look completed to the client. The message deliberately says
"unrelated to prompt size": clients map context-overflow phrasing to the **non-retryable**
`CONTEXT_WINDOW_EXCEEDED`, so even denying that diagnosis in words would mis-file the turn.

With `stream_options: { "include_usage": true }` the final chunk also carries `usage`, whose `completion_tokens` and `total_tokens` are the upstream accumulated output counter and whose `prompt_tokens` stays `0` because the web endpoint never reports input tokens. Without that opt-in no streaming chunk carries `usage`, so configure clients such as Pi with `supportsUsageInStreaming: false` when they cannot request it.

## Tool-call mapping

Function calling is simulated through a text protocol because DeepSeek Web has no native OpenAI function tool endpoint.

Expected model output:

```text
<tool_call>
{"name":"read","arguments":{"path":"README.md"}}
</tool_call>
```

DeepSeek Web also emits its own markup protocol whenever the model treats the supplied tools as native function calls. That shape is accepted and converted as well:

```text
<｜｜DSML｜｜invoke name="read">
<｜｜DSML｜｜parameter name="path" string="true">README.md</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
```

The `｜｜DSML｜｜` marker can be partially missing in the upstream stream, so bare `<invoke name="...">` tags are read the same way. Set `DS_TOOLS=native` to ask for this shape instead of the JSON blocks.

Valid calls become:

- Chat Completions: `assistant.tool_calls[]`
- Responses: `output[]` item with `type: "function_call"`

Tool result history is accepted as Chat `role: "tool"`/`"function"` or Responses `function_call_output`. The parser also recognizes several malformed shapes observed in real model output, but the documented strict shape is the only one prompts should request.

## Session semantics

This adapter's response ID is a continuation handle derived from the DeepSeek session. It is not an OpenAI-hosted stored response. `previous_response_id` therefore means “continue the persisted local DeepSeek session,” not “retrieve an OpenAI response object.”

Clients that send complete history can continue without `previous_response_id`; the session store matches normalized user/assistant/tool history. Model and thinking changes do not intentionally fork a matched session.

Do not send concurrent turns against one conversation.

## Errors

Non-streaming errors use an OpenAI-style object:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "..."
  }
}
```

Responses streaming errors use a top-level event payload:

```json
{
  "type": "error",
  "code": "deepseek_web_error",
  "message": "...",
  "param": null
}
```

Upstream HTTP failures are surfaced as `502`. Invalid JSON/input is `400`, oversized bodies are `413`, and invalid API keys are `401`.

Chat Completions streaming errors arrive as an in-band frame after the headers are already flushed, so the
status travels inside the payload as well: `data: {"error":{"message":"...","status":504}}`. Clients that
only read the message would otherwise default to a transport failure and retry something that will never
succeed.

## Not supported

- Image, audio, video, or file input/upload

  **Upstream status (spike, 2026-10-21):** DeepSeek Web *does* have a working file pipeline. A real
  logged-in browser session was observed uploading a test image through
  `POST /api/v0/file/upload_file` (multipart, `x-ds-pow-response` required) and receiving a file id that
  `/api/v0/chat/completion` accepted in `ref_file_ids`; the model answered a question about the image's
  content correctly. The declared caps live in `GET /api/v0/client/settings` under each model's
  `file_feature`: `max_input_file_count: 50`, `max_upload_file_size: 104857600` (100 MiB),
  `token_limit: 890880`, `vision: true`, and a ~1000-entry `support_file_exts` list.

  This proxy still does not expose it: no input channel maps `image_url`/`input_file` to
  `ref_file_ids`, so the entry above remains true from a client's point of view. What is missing is
  product work (binary through our HTTP layer, quota and error mapping, session-lineage changes), not
  an unknown upstream contract. See `docs/spike-file-upload.md`.
- OpenAI-hosted background responses and response retrieval/cancel/delete endpoints
- Native structured output / JSON schema enforcement
- Native function calling or guaranteed parallel calls
- Built-in OpenAI tools such as code interpreter, computer use, or file search
- Reliable input-token accounting
- Concurrent mutation of a single DeepSeek session

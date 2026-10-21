# Spike 记录：DeepSeek Web 附件上传契约（`ref_file_ids`）

> 2026-10-21 实测。回答 TODO P0-A3③："上游到底有没有文件输入，自己补一条通路要多少钱"。
> 方法：一次性有头 Chrome（独立 profile、CDP 9334）真人扫码登录后，只读观测 + 一次授权的最小上传，
> 全部请求/响应按名字脱敏（`authorization` / `cookie` / `x-ds-pow-response` 只报头名，长串打码）。
> 探测脚本在 `spike/ref-file-upload` 分支（本地，未推远端）。

## 结论

**上游有完整的文件输入通路，`ref_file_ids` 不是协议化石。** 但"上游支持"与"本反代支持"是两件事：
本反代至今没有把 `image_url` / `input_file` 映射到 `ref_file_ids` 的输入通道，所以 `docs/api.md`
的 Not supported 第一条对客户端仍然成立。缺的是产品工作，不是未知契约。

已实测闭环：上传 → 拿到 file id → `ref_file_ids: [id]` 进 `/api/v0/chat/completion` →
模型正确回答图片内容（问"这张图最主要的一个颜色"，答"绿色"，测试图正是纯绿色）。
**授权的那一条测试会话已当场删除**（HTTP 200）。

## 上传契约表（逐格实测）

| 项 | 实测值 | 证据 |
|---|---|---|
| 上传 endpoint 路径 | `POST /api/v0/file/upload_file` | 上传时抓到的唯一文件写请求 |
| HTTP 方法 / content-type | POST / `multipart/form-data`（boundary 由浏览器生成） | 请求 `content-type` 头 |
| 是否需要独立 PoW | **需要**，头 `x-ds-pow-response`，`target_path: "/api/v0/chat/completion"` 领挑战 | 与 completion 同一套 PoW；`src/deepseek/pow.ts` 的流程原样可用（CDN worker 解题 → base64） |
| multipart 字段名 | 未取到（由上游 SPA 的 `<input type=file>` 直接提交，无自定义字段名） | `setInputFiles` 触发的原生提交 |
| 请求必需头（不含值） | `authorization`、`x-ds-pow-response`、cookie；页面另带 7 个 `x-client-*` / `x-device-*` | 请求头名清单（值未记录） |
| 响应里文件 id 的字段名 | `data.biz_data.id`（41 字符）；`file_name` / `file_size` / `is_image` / `model_kind` 同层 | 上传响应 |
| 文件状态机 | `PENDING` → `PARSING` → `SUCCESS`，轮询用 `GET /api/v0/file/fetch_files?file_ids=` | 两次 fetch_files 响应 |
| token 计量 | 74 字节 PNG 记 **184** token（`token_usage`） | SUCCESS 状态响应 |
| 允许的类型 | ~1000 个扩展名（见 `file_feature.support_file_exts`）：常见图片/pdf/office/文本/全部主流代码后缀 | `client/settings` 响应 |
| 单文件上限 | `max_upload_file_size: 104857600`（100 MiB） | 同上 |
| 每轮可带几个文件 | `max_input_file_count: 50`；页面 `input[type=file]` 为 `multiple` | 同上 + DOM |
| `file_feature.token_limit` 语义 | 文件 token 预算，`token_limit` 与 `token_limit_with_thinking` 同为 890880（思考模式不另算） | 同上 |
| completion 带 id 后模型是否真"看到"了图 | **是**。答"绿色"与测试图实际颜色一致 | completion SSE（JSON-patch 流，`fragments[].content` 取正文） |
| 失败形态（配额/尺寸/风控） | **未测**（只做了一次成功上传，未触配额/超限） | — |

## `client/settings` 里还有用的东西

真实请求形态（手搓 fetch 会被 `INVALID_PARAM` 拒绝，必须带齐）：query `did` + `scope`，
头 `x-client-platform` / `x-client-version` / `x-client-locale` / `x-client-bundle-id` /
`x-client-timezone-offset` / `x-device-id` / `x-device-model`。
响应三层包装：`data.biz_data.settings`，其中 `model_configs` 是数组，每个模型带自己的 `file_feature`。

## 若立项，要付的代价（按实测重排）

1. **上传通路**：新 endpoint + multipart 组装 + PoW（复用 `pow.ts`，不新写）。
2. **反代新增输入通道**：OpenAI `image_url` / Responses `input_file` → `ref_file_ids`。
   **大二进制要穿过我们的 HTTP 层**：`readJsonBody` 的 1MB 上限、日志脱敏、`data/` 卫生都得重做。
3. **会话血缘**：`sessionStore` / `sessionTurns` 按 prompt 指纹复用会话，附件会让指纹与真实内容脱节。
4. **能力契约**：新增 capability（如 `file-attachments`），插件侧同步把 `inputModalities` 从 `['text']` 改掉。
   注意：现在如实申报 `['text']` 是有意的，谎报会被内核判 `does not declare image input`。
5. **上游限制比想象中宽**：50 文件 / 100 MiB / 1000 种后缀 / vision=true。**反代侧 1MB body 上限是
   比上游更紧的瓶颈**——真要做，先解决这个。
6. **长期维护**：依赖私有接口稳定性，本仓已被"协议形态漂移"咬过两次。

**建议**：维持 Not supported，把力气放回 P1 与"文字优先"替代路径。上游契约已记录在此，
将来若真要立项，直接照 §上传契约表 施工，不必再逆一次。

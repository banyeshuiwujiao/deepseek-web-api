# Spike：DeepSeek Web 的附件（`ref_file_ids`）到底能不能打通

分支：`spike/ref-file-upload`（本地临时分支，不合 main、不推远端）。
起因：`TODO.md` 的 P0-A3③。上一轮的结论是"参考实现没有上传通路"，这条分支要回答的是**"自己补一条通路要多少钱"**。

## 已经确定的事实（都在本仓内可复核）

| 事实 | 位置 |
|---|---|
| 完成请求体里有 `ref_file_ids`，本仓恒传空数组 | `src/deepseek/completion.ts:44`、`SPEC.md:73`、`_reference/server.mjs:536` |
| vendored 参考实现全文**没有任何上传痕迹**（`upload`/`multipart`/`file_id` 零命中） | `grep -rn -i "upload\|file_id\|multipart" _reference src` |
| PoW 挑战与 `target_path` 绑定，换一条 endpoint 就要重新领挑战 | `src/deepseek/pow.ts`（`create_pow_challenge` 的 body 里 `target_path`） |
| 请求侧鉴权 = `Bearer userToken`（从页面 localStorage 取）+ cookie（每次从 Chrome 刷） | `src/deepseek/completion.ts:24-35`、`src/browser/*` |
| 对外文档已把 file/image 列为 Not supported | `docs/api.md` |

**结论性判断**：`ref_file_ids` 说明上游协议**允许**带文件，但"允许"与"我们知道怎么拿 id"是两件事。
本仓没有、也不可能有 id 的来源，除非观测一次真实上传。

## 这个 spike 能提供什么、不能提供什么

- 能：用 `scripts/spike-file-capture.mjs` 观测**已登录浏览器**在真实上传时打的 endpoint、方法、请求/响应形状，
  从而判断"要不要新 PoW、是不是 multipart、id 在哪个字段"。
- 不能：不读上游前端代码（策略与合规都不合算），不猜 endpoint 去戳生产接口（拿用户凭证乱试是最差做法）。

观测脚本的红线写死在代码里：`authorization`/`cookie`/`x-ds-pow-response` 这类头**按名字丢弃**，
长串一律 `<redacted-long-token>`，body 截 400 字符，query 只报键名。观测本身不产生写操作，
但**要你在那个标签页里真的附件一次**——那次上传会进你自己的 DeepSeek 账号。

## 打通之后要付的代价（先算清楚再决定）

1. 上传通路：新 endpoint + multipart 组装 + 可能的独立 PoW；上游返回什么错误形态未知（配额、尺寸、格式）。
2. 反代侧要新增输入通道：OpenAI `image_url` / Responses `input_file` → 上游 `ref_file_ids`，
   意味着**大二进制要穿过我们的 HTTP 层**，`readJsonBody` 的 1MB 上限、日志脱敏、`data/` 目录卫生都得重做一遍。
3. 会话血缘：`sessionStore`/`sessionTurns` 按 prompt 指纹复用会话，附件会让指纹与真实内容脱节。
4. 能力契约：得新增 capability（例如 `file-attachments`）并同步插件的 `inputModalities`（现在如实申报 `['text']`）。
5. 风险：这条通路完全依赖私有接口的稳定性，上游改版即坏；本仓现在已经被"协议形态漂移"咬过两次。

我的建议顺序：先观测一次（10 分钟，零代码改动），拿到真实契约后再决定要不要立项；
如果观测显示需要新的 PoW +  multipart + 配额体系，那**维持 Not supported**，把力气花在
P0-A3①② 的"文字优先"替代路径上更划算——真机里救场的是 DOM/接口里那行 URL，不是像素。

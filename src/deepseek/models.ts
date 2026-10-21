/** Maps public model and feature options to DeepSeek Web boolean capabilities. */
import { MAX_REF_FILE_IDS } from "../config/constants.js";
import type { ModelResolution, ModelType, PublicModel, RequestBody } from "./types.js";
import { isRecord } from "../utils/json.js";

const MODEL_MAP: Readonly<Record<string, ModelType>> = {
  "deepseek-v4-flash": "default",
  "deepseek-v4-pro": "expert",
  "deepseek-chat": "default",
  "deepseek-reasoner": "expert",
  default: "default",
  expert: "expert",
  flash: "default",
  pro: "expert",
};

export function resolveModel(body: RequestBody): ModelResolution {
  const raw = String(body.model || "deepseek-v4-flash").toLowerCase();
  const inferred: ModelType = raw.includes("pro") || raw.includes("expert") ? "expert" : "default";
  const modelType = MODEL_MAP[raw] ?? inferred;
  const publicModel: PublicModel =
    modelType === "expert" ? "deepseek-v4-pro" : "deepseek-v4-flash";
  return { raw, modelType, publicModel };
}

/** DeepSeek Web exposes only an on/off switch, not distinct reasoning levels. */
export function resolveThinking(body: RequestBody): boolean {
  if (body.thinking_enabled !== undefined) return Boolean(body.thinking_enabled);
  if (body.reasoning_enabled !== undefined) return Boolean(body.reasoning_enabled);
  if (typeof body.thinking === "boolean") return body.thinking;
  if (typeof body.reasoning === "boolean") return body.reasoning;

  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const effort = reasoning?.effort ?? body.thinking_level ?? body.reasoning_effort ?? body.effort;
  if (effort === undefined || effort === null) return true;
  return !["none", "off", "0", "false", "disabled"].includes(String(effort).toLowerCase());
}

/** Honor the OpenAI stream_options opt-in; usage stays absent unless a client asks for it. */
export function resolveIncludeUsage(body: RequestBody): boolean {
  const options = isRecord(body.stream_options) ? body.stream_options : undefined;
  return options?.include_usage === true;
}

/** Expert mode cannot search on the Web client, so the trusted server forces it off. */
export function resolveSearch(body: RequestBody, modelType: ModelType): boolean {
  if (modelType === "expert") return false;
  if (body.search_enabled !== undefined) return Boolean(body.search_enabled);
  if (body.web_search !== undefined) return Boolean(body.web_search);
  if (!Array.isArray(body.tools)) return false;
  return body.tools.some((tool) => {
    const type = isRecord(tool) ? tool.type : tool;
    return /search|web/i.test(String(type ?? ""));
  });
}

/**
 * Upstream file ids to attach to a completion (DeepSeek's `ref_file_ids`).
 *
 * Scope for now: pass through ids a caller already holds (`ref_file_ids` / `file_ids` on the request
 * body). Mapping OpenAI shapes (image_url data URLs, input_file) onto real uploads is deliberately
 * *not* here yet -- that needs the body-size and logging work tracked separately, so shipping the
 * transport first keeps this step revertable on its own.
 */
export function resolveFileIds(body: RequestBody): string[] {
  const raw = body.ref_file_ids ?? body.file_ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, MAX_REF_FILE_IDS);
}

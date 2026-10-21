/** Core boundary types shared across model resolution, sessions, and streaming. */
export type ModelType = "default" | "expert";
export type PublicModel = "deepseek-v4-flash" | "deepseek-v4-pro";

export interface ModelResolution {
  raw: string;
  modelType: ModelType;
  publicModel: PublicModel;
}

export interface MessageTurn {
  role: string;
  content: string;
  /**
   * How many attachments this turn carried, when it carried any.
   *
   * Session matching must not treat "same words, with an image" and "same words, no image" as the same
   * turn: reusing that session would silently drop the image and the model would answer from text
   * alone. A count is used rather than file ids because ids differ between uploads of the same image,
   * and counting keeps a genuine re-send of the same picture matching.
   */
  attachmentCount?: number;
}

export interface RequestBody extends Record<string, unknown> {
  model?: unknown;
  input?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
}

export interface DeepSeekAuth {
  token: string;
  cookie: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  dumped_at: string;
}

export interface DeepSeekFragment {
  type?: unknown;
  content?: unknown;
}

export interface DeepSeekSseEvent {
  event: string | null;
  data: Record<string, unknown>;
}

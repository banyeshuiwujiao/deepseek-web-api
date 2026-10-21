/**
 * Uploads the attachments carried by one request body.
 *
 * Kept out of client.ts because the upload path needs three collaborators the client only borrows
 * (login state, the browser page for PoW, and the pow worker URL) and none of them belong to the
 * completion orchestration itself.
 */
import type { Page } from "playwright-core";

import type { AppConfig } from "../config/env.js";
import type { LoginManager } from "../browser/login.js";
import type { DeepSeekAuth } from "./types.js";
import { resolveAttachments, uploadAttachments } from "./attachments.js";
import { UPLOAD_PATH } from "./fileUpload.js";
import { prepareCompletion } from "./pow.js";

export interface AttachmentUploader {
  config: AppConfig;
  login: LoginManager;
}

/**
 * Upload every attachment in the body and return the upstream ids in order.
 *
 * Returns an empty list when uploads are disabled or the body carries no attachment. Failures
 * propagate: a half-uploaded attachment set is worse than a clear error, because the model would
 * silently answer without part of the evidence.
 */
export async function uploadRequestAttachments(
  uploader: AttachmentUploader,
  body: Record<string, unknown>,
): Promise<string[]> {
  const { config, login } = uploader;
  if (config.fileUploads === false) return [];
  const attachments = await resolveAttachments(body);
  if (attachments.length === 0) return [];

  const auth = await login.dumpCurrent();
  const page = await login.page();
  return uploadAttachments({
    baseUrl: config.baseUrl,
    auth,
    token: auth.token,
    // Each upload needs its own proof bound to the upload path; no chat session is created.
    powHeaderFor: () => mintUploadProof(page, config, auth),
    attachments,
  });
}

async function mintUploadProof(page: Page, config: AppConfig, auth: DeepSeekAuth): Promise<string> {
  const proof = await prepareCompletion({
    page,
    powWorkerUrl: config.powWorkerUrl,
    modelType: "default",
    fallbackToken: auth.token,
    sessionId: null,
    reuseSession: false,
    targetPath: UPLOAD_PATH,
    createSession: false,
  });
  return proof.powHeader;
}

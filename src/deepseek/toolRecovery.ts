/**
 * One automatic retry for a tool turn the parser could not use, then an honest outcome.
 *
 * This lives apart from the client because its whole job is choosing between three different failures,
 * each of which has to be described differently to whoever reads the log:
 * the retry recovered, the retry stayed empty and we now know why, or the retry stayed empty and the
 * answer would be prose nobody can act on.
 */
import type { CompletionDiagnostics } from "./mapResponses.js";
import { emptyUpstreamFailure } from "./streamWatch.js";
import { estimatePromptTokens } from "../utils/promptTokens.js";
import type { Logger } from "../utils/logger.js";

export interface RecoveryAttempt<T> {
  value: T;
  diagnostics: CompletionDiagnostics;
}
export interface RecoveryResult<T, Run> extends RecoveryAttempt<T> {
  run: Run;
  retry: number;
}

export async function withToolRecovery<T, Run extends { prompt: string }>(
  initialRun: Run,
  execute: (run: Run, retry: number, finalAttempt: boolean) => Promise<RecoveryAttempt<T>>,
  context: {
    logger: Logger;
    logFields: (run: Run, diagnostics: CompletionDiagnostics) => Record<string, unknown>;
    logAttempt: (run: Run, diagnostics: CompletionDiagnostics) => void;
    prepareRetry: () => Promise<Run>;
  },
): Promise<RecoveryResult<T, Run>> {
  const first = await execute(initialRun, 0, false);
  context.logAttempt(initialRun, first.diagnostics);
  if (!first.diagnostics.recoverableEmpty) return { ...first, run: initialRun, retry: 0 };

  context.logger.info("Retrying unusable DeepSeek tool response", context.logFields(initialRun, first.diagnostics));
  const retryRun = await context.prepareRetry();
  const second = await execute(retryRun, 1, true);
  context.logAttempt(retryRun, second.diagnostics);
  if (!second.diagnostics.recoverableEmpty) {
    context.logger.info("DeepSeek tool response recovered", context.logFields(retryRun, second.diagnostics));
    return { ...second, run: retryRun, retry: 1 };
  }

  const failure = emptyUpstreamFailure(
    second.diagnostics.streamEvidence,
    retryRun.prompt.length,
    estimatePromptTokens(retryRun.prompt),
  );
  if (failure) {
    // Delivering the apology string as ordinary content made DSH report a completed turn; the plugin's own
    // EMPTY_RESPONSE path could never fire, and nobody reading the log could tell availability from success.
    context.logger.warn("DeepSeek tool turn failed as an attributed empty response", {
      ...context.logFields(retryRun, second.diagnostics),
      fallbackVisible: false,
    });
    throw failure;
  }
  context.logger.warn("DeepSeek tool response remained unusable after retry", {
    ...context.logFields(retryRun, second.diagnostics),
    fallbackVisible: true,
  });
  return { ...second, run: retryRun, retry: 1 };
}

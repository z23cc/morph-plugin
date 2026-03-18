/**
 * FastApply logic and safety guards for the Morph edit tool.
 *
 * Platform-agnostic — no imports from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import { EXISTING_CODE_MARKER } from "./types.js";

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

/**
 * Normalize code_edit input from LLM tool calls.
 *
 * Agents frequently wrap tool arguments in markdown fences (```lang ... ```).
 * When this is nested inside Morph's <update> XML tag, it confuses the merge
 * model. This function strips a single outer fence pair using line-based parsing.
 */
export function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");

  if (lines.length < 3) return codeEdit;

  const firstLine = lines[0]!.trimEnd();
  const lastLine = lines[lines.length - 1]!.trimEnd();

  if (/^```[\w-]*$/.test(firstLine) && /^```$/.test(lastLine)) {
    return lines.slice(1, -1).join("\n");
  }

  return codeEdit;
}

// ---------------------------------------------------------------------------
// Safety guard checks (pure functions — no side effects)
// ---------------------------------------------------------------------------

/**
 * Check whether the merged output contains leaked marker text that was not
 * present in the original file. This indicates the merge model treated markers
 * as literal code instead of expanding them.
 */
export function detectMarkerLeakage(
  originalCode: string,
  mergedCode: string,
  hasMarkers: boolean,
): boolean {
  const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);
  return (
    hasMarkers &&
    !originalHadMarker &&
    mergedCode.includes(EXISTING_CODE_MARKER)
  );
}

/**
 * Check whether the merged output has catastrophic truncation — indicating the
 * merge model dropped large portions of the original file.
 *
 * Triggers when BOTH:
 * - Character loss > 60%
 * - Line loss > 50%
 *
 * Returns the loss metrics along with the triggered flag.
 */
export function detectTruncation(
  originalCode: string,
  mergedCode: string,
  hasMarkers: boolean,
): { triggered: boolean; charLoss: number; lineLoss: number } {
  if (originalCode.length === 0) {
    return { triggered: false, charLoss: 0, lineLoss: 0 };
  }
  const originalLineCount = originalCode.split("\n").length;
  const mergedLineCount = mergedCode.split("\n").length;
  const charLoss =
    (originalCode.length - mergedCode.length) / originalCode.length;
  const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;
  return {
    triggered: hasMarkers && charLoss > 0.6 && lineLoss > 0.5,
    charLoss,
    lineLoss,
  };
}

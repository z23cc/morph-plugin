/**
 * morph edit --file <path>
 *
 * Reads code edit content from stdin, reads the target file from disk,
 * calls Morph FastApply API to merge the edit, applies safety guards,
 * and writes the merged result back to the file.
 *
 * Exit codes:
 *   0 = success
 *   1 = input error
 *   2 = API error
 *   3 = safety guard blocked
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { MorphClient } from "@morphllm/morphsdk";
import {
  generateUnifiedDiff,
  colorizeDiff,
  countChanges,
} from "../utils/diff.js";

const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_TIMEOUT = 30000;
const EXISTING_CODE_MARKER = "// ... existing code ...";

/**
 * Strip a single outer markdown fence pair from a code edit string.
 * Agents frequently wrap tool arguments in ```lang ... ``` fences.
 */
function normalizeCodeEdit(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");

  if (lines.length < 3) return codeEdit;

  const firstLine = lines[0]!;
  const lastLine = lines[lines.length - 1]!;

  if (/^```[\w-]*$/.test(firstLine) && /^```$/.test(lastLine)) {
    return lines.slice(1, -1).join("\n");
  }

  return codeEdit;
}

/**
 * Read all of stdin as a UTF-8 string.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runEdit(args: string[]): Promise<void> {
  // Parse --file argument
  const fileIndex = args.indexOf("--file");
  if (fileIndex === -1 || fileIndex + 1 >= args.length) {
    console.error("Error: --file <path> is required");
    console.error("Usage: morph edit --file <path> < edit-content.txt");
    process.exit(1);
  }

  const filepath = args[fileIndex + 1]!;
  const apiKey = process.env.MORPH_API_KEY;

  if (!apiKey) {
    console.error(
      "Error: MORPH_API_KEY environment variable is required",
    );
    console.error("Get your API key at: https://morphllm.com/dashboard/api-keys");
    process.exit(1);
  }

  // Check if stdin is a TTY (no piped input)
  if (process.stdin.isTTY) {
    console.error("Error: code edit content must be piped via stdin");
    console.error(
      'Usage: echo "new code" | morph edit --file <path>',
    );
    process.exit(1);
  }

  // Read stdin
  const rawCodeEdit = await readStdin();
  if (!rawCodeEdit.trim()) {
    console.error("Error: stdin is empty -- no code edit content provided");
    process.exit(1);
  }

  const codeEdit = normalizeCodeEdit(rawCodeEdit);

  // Read target file
  let originalCode: string;
  try {
    originalCode = readFileSync(filepath, "utf-8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.error(`Error: file not found: ${filepath}`);
    } else {
      console.error(`Error reading file ${filepath}: ${error.message}`);
    }
    process.exit(1);
  }

  const originalLineCount = originalCode.split("\n").length;
  const hasMarkers = codeEdit.includes(EXISTING_CODE_MARKER);

  // Call Morph FastApply API
  const morph = new MorphClient({
    apiKey,
    timeout: MORPH_TIMEOUT,
  });

  const startTime = Date.now();
  let result;

  try {
    result = await morph.fastApply.applyEdit(
      {
        originalCode,
        codeEdit,
        instructions: "Apply the code edit",
        filepath,
      },
      {
        morphApiUrl: MORPH_API_URL,
        generateUdiff: true,
      },
    );
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: Morph API request failed after ${duration}ms: ${error.message}`,
    );
    process.exit(2);
  }

  const apiDuration = Date.now() - startTime;

  if (!result.success || !result.mergedCode) {
    console.error(`Error: Morph API failed: ${result.error}`);
    process.exit(2);
  }

  const mergedCode = result.mergedCode;

  // Safety guard: marker leakage detection
  const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);
  if (
    hasMarkers &&
    !originalHadMarker &&
    mergedCode.includes(EXISTING_CODE_MARKER)
  ) {
    console.error(
      `Error: marker leakage detected in merged output for ${filepath}`,
    );
    console.error(
      `The merge model treated "${EXISTING_CODE_MARKER}" as literal code instead of expanding it.`,
    );
    console.error("No file changes were written.");
    process.exit(3);
  }

  // Safety guard: catastrophic truncation detection
  const mergedLineCount = mergedCode.split("\n").length;
  const charLoss =
    (originalCode.length - mergedCode.length) / originalCode.length;
  const lineLoss =
    (originalLineCount - mergedLineCount) / originalLineCount;

  if (hasMarkers && charLoss > 0.6 && lineLoss > 0.5) {
    console.error(
      `Error: catastrophic truncation detected for ${filepath}`,
    );
    console.error(
      `Original: ${originalLineCount} lines (${originalCode.length} chars)`,
    );
    console.error(
      `Merged:   ${mergedLineCount} lines (${mergedCode.length} chars)`,
    );
    console.error(
      `Loss:     ${Math.round(charLoss * 100)}% characters, ${Math.round(lineLoss * 100)}% lines`,
    );
    console.error("No file changes were written.");
    process.exit(3);
  }

  // Write merged result
  try {
    writeFileSync(filepath, mergedCode, "utf-8");
  } catch (err) {
    const error = err as Error;
    console.error(`Error writing file ${filepath}: ${error.message}`);
    process.exit(1);
  }

  // Generate and output diff
  const diffLines = generateUnifiedDiff(originalCode, mergedCode, filepath);
  const { additions, deletions } = countChanges(diffLines);

  if (diffLines.length > 2) {
    // More than just headers
    console.log(colorizeDiff(diffLines));
  }

  const shortPath = basename(filepath);
  console.error(
    `morph edit: ${shortPath} +${additions}/-${deletions} (${apiDuration}ms)`,
  );
}

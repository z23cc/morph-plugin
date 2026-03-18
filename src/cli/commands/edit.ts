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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { MorphClient } from "@morphllm/morphsdk";
import {
  MORPH_API_URL,
  MORPH_TIMEOUT,
  EXISTING_CODE_MARKER,
} from "../../core/types.js";
import {
  normalizeCodeEditInput,
  detectMarkerLeakage,
  detectTruncation,
} from "../../core/edit.js";
import {
  generateUnifiedDiff,
  colorizeDiff,
  countChanges,
} from "../utils/diff.js";

/**
 * Read all of stdin as a UTF-8 string, with a timeout to prevent indefinite hangs.
 */
async function readStdin(timeoutMs = 30000): Promise<string> {
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdinDone = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stdin read timed out after ${timeoutMs}ms`)), timeoutMs);
    // Unref so the timer doesn't keep the process alive
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  });
  await Promise.race([stdinDone, timeout]);
  if (timer) clearTimeout(timer);
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
  if (filepath.startsWith("-")) {
    console.error(`Error: --file value looks like a flag: "${filepath}"`);
    console.error("Usage: morph edit --file <path> < edit-content.txt");
    process.exit(1);
  }

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

  const codeEdit = normalizeCodeEditInput(rawCodeEdit);
  const hasMarkers = codeEdit.includes(EXISTING_CODE_MARKER);

  // Read target file (or create if it doesn't exist and no markers)
  let originalCode: string;
  if (!existsSync(filepath)) {
    if (!hasMarkers) {
      // No markers = full file content, create new file
      writeFileSync(filepath, codeEdit, "utf-8");
      const lineCount = codeEdit.split("\n").length;
      console.error(`morph edit: created ${basename(filepath)} (${lineCount} lines)`);
      return;
    }
    console.error(`Error: file not found: ${filepath}`);
    console.error(
      `The file doesn't exist and the code edit contains "${EXISTING_CODE_MARKER}" markers.`,
    );
    console.error("For new files, provide the complete content without markers.");
    process.exit(1);
  }

  try {
    originalCode = readFileSync(filepath, "utf-8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    console.error(`Error reading file ${filepath}: ${error.message}`);
    process.exit(1);
  }

  const originalLineCount = originalCode.split("\n").length;

  // Pre-flight marker check
  if (!hasMarkers && originalLineCount > 10) {
    console.error(
      `Error: missing "${EXISTING_CODE_MARKER}" markers.`,
    );
    console.error(
      `Your code edit would replace the entire file (${originalLineCount} lines).`,
    );
    console.error("Use markers to wrap your changes, or use a different tool.");
    process.exit(1);
  }

  // Call Morph FastApply API
  const morph = new MorphClient({ apiKey, timeout: MORPH_TIMEOUT });
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
      { morphApiUrl: MORPH_API_URL, generateUdiff: true },
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

  // Safety guard: marker leakage
  if (detectMarkerLeakage(originalCode, mergedCode, hasMarkers)) {
    console.error(
      `Error: marker leakage detected in merged output for ${filepath}`,
    );
    console.error("The merge model treated markers as literal code. No changes written.");
    process.exit(3);
  }

  // Safety guard: catastrophic truncation
  const truncation = detectTruncation(originalCode, mergedCode, hasMarkers);
  if (truncation.triggered) {
    const mergedLineCount = mergedCode.split("\n").length;
    console.error(`Error: catastrophic truncation detected for ${filepath}`);
    console.error(
      `Original: ${originalLineCount} lines | Merged: ${mergedLineCount} lines | Loss: ${Math.round(truncation.charLoss * 100)}% chars, ${Math.round(truncation.lineLoss * 100)}% lines`,
    );
    console.error("No changes written.");
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
    console.log(colorizeDiff(diffLines));
  }

  console.error(
    `morph edit: ${basename(filepath)} +${additions}/-${deletions} (${apiDuration}ms)`,
  );
}

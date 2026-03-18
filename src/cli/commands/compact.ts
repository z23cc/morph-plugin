/**
 * morph compact [--ratio <0.05-1.0>] [--preserve-recent <n>]
 *
 * Compresses text/conversation context via Morph Compact API.
 * Reads input from stdin, returns compressed output to stdout.
 * 25,000+ tok/s context compression in under 2 seconds.
 *
 * Exit codes:
 *   0 = success
 *   1 = input error
 *   2 = API error
 */

import { CompactClient } from "@morphllm/morphsdk";
import { MORPH_API_URL } from "../../core/types.js";
import { readStdin } from "../utils/stdin.js";

const MORPH_COMPACT_TIMEOUT = 60000;

export async function runCompact(args: string[]): Promise<void> {
  const apiKey = process.env.MORPH_API_KEY;
  if (!apiKey) {
    console.error("Error: MORPH_API_KEY environment variable is required");
    console.error("Get your API key at: https://morphllm.com/dashboard/api-keys");
    process.exit(1);
  }

  // Parse --ratio (optional, default 0.3)
  const ratioIndex = args.indexOf("--ratio");
  let ratio = 0.3;
  if (ratioIndex !== -1) {
    if (ratioIndex + 1 >= args.length) {
      console.error("Error: --ratio requires a value (0.05 - 1.0)");
      process.exit(1);
    }
    const parsed = parseFloat(args[ratioIndex + 1]!);
    if (!Number.isFinite(parsed) || parsed < 0.05 || parsed > 1.0) {
      console.error("Error: --ratio must be between 0.05 and 1.0");
      process.exit(1);
    }
    ratio = parsed;
  }

  // Parse --preserve-recent (optional, default 0)
  const preserveRecentIndex = args.indexOf("--preserve-recent");
  let preserveRecent = 0;
  if (preserveRecentIndex !== -1) {
    if (preserveRecentIndex + 1 >= args.length) {
      console.error("Error: --preserve-recent requires an integer value");
      process.exit(1);
    }
    const parsed = parseInt(args[preserveRecentIndex + 1]!, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error("Error: --preserve-recent must be a non-negative integer");
      process.exit(1);
    }
    preserveRecent = parsed;
  }

  // Check if stdin is a TTY (no piped input)
  if (process.stdin.isTTY) {
    console.error("Error: text content must be piped via stdin");
    console.error("Usage: cat conversation.txt | morph compact");
    console.error('       echo "long text..." | morph compact --ratio 0.2');
    process.exit(1);
  }

  let input: string;
  try {
    input = await readStdin();
  } catch (err) {
    const error = err as Error;
    console.error(`Error: ${error.message}`);
    process.exit(1);
    return; // unreachable, satisfies TS
  }

  if (!input.trim()) {
    console.error("Error: stdin is empty -- no content to compact");
    process.exit(1);
  }

  const compactClient = new CompactClient({
    morphApiKey: apiKey,
    morphApiUrl: MORPH_API_URL,
    timeout: MORPH_COMPACT_TIMEOUT,
  });

  const startTime = Date.now();

  try {
    const result = await compactClient.compact({
      input,
      compressionRatio: ratio,
      preserveRecent,
    });

    const duration = Date.now() - startTime;
    const inputChars = input.length;
    const output = result.output || "";
    const outputChars = output.length;
    const compressionPercent = inputChars > 0 ? Math.round((1 - outputChars / inputChars) * 100) : 0;

    // Output compacted text to stdout (precise, no extra newlines)
    process.stdout.write(output);
    if (output.length > 0 && !output.endsWith("\n")) {
      process.stdout.write("\n");
    }

    // Stats to stderr
    console.error(
      `morph compact: ${inputChars} → ${outputChars} chars (${compressionPercent}% reduction, ${duration}ms)`,
    );
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: Morph Compact API failed after ${duration}ms: ${error.message}`,
    );
    process.exit(2);
  }
}

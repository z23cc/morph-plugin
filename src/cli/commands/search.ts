/**
 * morph search --query <text> [--dir <path>]
 *
 * Calls WarpGrep API for local codebase search.
 *
 * Exit codes:
 *   0 = success (even if no results)
 *   1 = input error
 *   2 = API error
 */

import { WarpGrepClient } from "@morphllm/morphsdk";
import type { WarpGrepResult } from "@morphllm/morphsdk";

const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_WARP_GREP_TIMEOUT = 60000;

/**
 * Format WarpGrep search results for CLI output.
 */
function formatResult(result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed: ${result.error}`;
  }

  if (!result.contexts || result.contexts.length === 0) {
    return "No relevant code found. Try rephrasing your search term.";
  }

  const parts: string[] = [];
  parts.push("Relevant context found:");
  parts.push("");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? "*"
        : ctx.lines.map(([s, e]) => `${s}-${e}`).join(",");
    parts.push(`  ${ctx.file}:${rangeStr}`);
  }

  parts.push("");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? ""
        : ` lines ${ctx.lines.map(([s, e]) => `${s}-${e}`).join(",")}`;
    parts.push(`--- ${ctx.file}${rangeStr} ---`);
    parts.push(ctx.content);
    parts.push("");
  }

  return parts.join("\n");
}

export async function runSearch(args: string[]): Promise<void> {
  // Parse --query argument
  const queryIndex = args.indexOf("--query");
  if (queryIndex === -1 || queryIndex + 1 >= args.length) {
    console.error("Error: --query <text> is required");
    console.error(
      "Usage: morph search --query <text> [--dir <path>]",
    );
    process.exit(1);
  }

  const query = args[queryIndex + 1]!;

  // Parse --dir argument (optional, defaults to cwd)
  const dirIndex = args.indexOf("--dir");
  const dir =
    dirIndex !== -1 && dirIndex + 1 < args.length
      ? args[dirIndex + 1]!
      : process.cwd();

  const apiKey = process.env.MORPH_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: MORPH_API_KEY environment variable is required",
    );
    console.error("Get your API key at: https://morphllm.com/dashboard/api-keys");
    process.exit(1);
  }

  const warpGrep = new WarpGrepClient({
    morphApiKey: apiKey,
    morphApiUrl: MORPH_API_URL,
    timeout: MORPH_WARP_GREP_TIMEOUT,
  });

  const startTime = Date.now();

  try {
    const generator = warpGrep.execute({
      searchTerm: query,
      repoRoot: dir,
      streamSteps: true,
    });

    let result: WarpGrepResult;

    for (;;) {
      const { value, done } = await generator.next();
      if (done) {
        result = value;
        break;
      }
    }

    const duration = Date.now() - startTime;
    const contextCount = result.contexts?.length ?? 0;

    console.log(formatResult(result));
    console.error(
      `morph search: ${contextCount} results (${duration}ms)`,
    );
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: WarpGrep search failed after ${duration}ms: ${error.message}`,
    );
    process.exit(2);
  }
}

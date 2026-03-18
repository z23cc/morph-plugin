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

import { statSync } from "node:fs";
import { WarpGrepClient } from "@morphllm/morphsdk";
import type { WarpGrepResult } from "@morphllm/morphsdk";
import { MORPH_API_URL, MORPH_WARP_GREP_TIMEOUT } from "../../core/types.js";
import { formatWarpGrepResult } from "../../core/search.js";

export async function runSearch(args: string[]): Promise<void> {
  // Parse --query argument
  const queryIndex = args.indexOf("--query");
  if (queryIndex === -1 || queryIndex + 1 >= args.length) {
    console.error("Error: --query <text> is required");
    console.error("Usage: morph search --query <text> [--dir <path>]");
    process.exit(1);
  }

  const query = args[queryIndex + 1]!;
  if (!query || query.startsWith("-")) {
    console.error("Error: --query requires a non-empty text value");
    process.exit(1);
  }

  // Parse --dir argument (optional, defaults to cwd)
  const dirIndex = args.indexOf("--dir");
  let dir: string;
  if (dirIndex !== -1) {
    if (dirIndex + 1 >= args.length) {
      console.error("Error: --dir requires a value");
      process.exit(1);
    }
    dir = args[dirIndex + 1]!;
    try {
      if (!statSync(dir).isDirectory()) {
        console.error(`Error: --dir is not a directory: ${dir}`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: directory not found: ${dir}`);
      process.exit(1);
    }
  } else {
    dir = process.cwd();
  }

  const apiKey = process.env.MORPH_API_KEY;
  if (!apiKey) {
    console.error("Error: MORPH_API_KEY environment variable is required");
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

    console.log(formatWarpGrepResult(result));
    console.error(`morph search: ${contextCount} results (${duration}ms)`);
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: WarpGrep search failed after ${duration}ms: ${error.message}`,
    );
    process.exit(2);
  }
}

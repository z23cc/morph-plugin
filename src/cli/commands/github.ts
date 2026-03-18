/**
 * morph github --repo <owner/repo> --query <text>
 * morph github --url <github-url> --query <text>
 *
 * Calls WarpGrep GitHub search API for public repositories.
 *
 * Exit codes:
 *   0 = success
 *   1 = input/repo error
 *   2 = API error
 */

import { WarpGrepClient } from "@morphllm/morphsdk";
import {
  MORPH_API_URL,
  MORPH_WARP_GREP_TIMEOUT,
  GITHUB_OWNER_REPO_PATTERN,
} from "../../core/types.js";
import {
  resolvePublicRepoLocator,
  lookupGitHubRepository,
  fetchGitHubRepoSuggestions,
  formatPublicRepoResolutionFailure,
} from "../../core/github.js";
import { formatWarpGrepResult } from "../../core/search.js";

/**
 * Parse --repo or --url from CLI args into a PublicRepoContextSearchArgs-like object.
 */
function parseRepoArgs(args: string[]): { owner_repo?: string; github_url?: string; search_term: string } {
  const repoIndex = args.indexOf("--repo");
  const urlIndex = args.indexOf("--url");
  const queryIndex = args.indexOf("--query");

  if (repoIndex !== -1 && urlIndex !== -1) {
    console.error("Error: provide either --repo or --url, not both");
    process.exit(1);
  }

  if (repoIndex === -1 && urlIndex === -1) {
    console.error("Error: --repo <owner/repo> or --url <github-url> is required");
    console.error("Usage: morph github --repo <owner/repo> --query <text>");
    process.exit(1);
  }

  if (queryIndex === -1 || queryIndex + 1 >= args.length) {
    console.error("Error: --query <text> is required");
    console.error("Usage: morph github --repo <owner/repo> --query <text>");
    process.exit(1);
  }

  const search_term = args[queryIndex + 1]!;

  if (repoIndex !== -1) {
    if (repoIndex + 1 >= args.length) {
      console.error("Error: --repo requires a value");
      process.exit(1);
    }
    return { owner_repo: args[repoIndex + 1]!, search_term };
  }

  if (urlIndex + 1 >= args.length) {
    console.error("Error: --url requires a value");
    process.exit(1);
  }
  return { github_url: args[urlIndex + 1]!, search_term };
}

export async function runGithub(args: string[]): Promise<void> {
  const parsed = parseRepoArgs(args);

  // Use core's resolver for consistent repo validation
  const locator = resolvePublicRepoLocator(parsed);
  if ("error" in locator) {
    console.error(`Error: ${locator.error}`);
    process.exit(1);
  }

  const repo = locator.repo;
  const apiKey = process.env.MORPH_API_KEY;

  if (!apiKey) {
    console.error("Error: MORPH_API_KEY environment variable is required");
    console.error("Get your API key at: https://morphllm.com/dashboard/api-keys");
    process.exit(1);
  }

  // Check if repo exists first
  const repoLookup = await lookupGitHubRepository(repo);
  if (repoLookup.status === "not_found") {
    const suggestions = await fetchGitHubRepoSuggestions(repo, parsed.search_term).catch(() => []);
    console.error(formatPublicRepoResolutionFailure(repo, repoLookup.detail, suggestions));
    process.exit(1);
  }

  const warpGrep = new WarpGrepClient({
    morphApiKey: apiKey,
    morphApiUrl: MORPH_API_URL,
    timeout: MORPH_WARP_GREP_TIMEOUT,
  });

  const startTime = Date.now();

  try {
    const result = await warpGrep.searchGitHub({
      searchTerm: parsed.search_term,
      github: repo,
    });

    const duration = Date.now() - startTime;
    const contextCount = result.contexts?.length ?? 0;

    if (!result.success) {
      const suggestions = await fetchGitHubRepoSuggestions(repo, parsed.search_term).catch(() => []);
      console.error(formatPublicRepoResolutionFailure(repo, result.error, suggestions));
      process.exit(1);
    }

    console.log(`Repository: ${repo}\n\n${formatWarpGrepResult(result)}`);
    console.error(`morph github: ${repo} ${contextCount} results (${duration}ms)`);
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: GitHub search failed for ${repo} after ${duration}ms: ${error.message}`,
    );

    const suggestions = await fetchGitHubRepoSuggestions(repo, parsed.search_term).catch(() => []);
    if (suggestions.length > 0) {
      console.error(formatPublicRepoResolutionFailure(repo, error.message, suggestions));
    }
    process.exit(2);
  }
}

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
import type { WarpGrepResult } from "@morphllm/morphsdk";

const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_WARP_GREP_TIMEOUT = 60000;
const GITHUB_REPO_API_URL = "https://api.github.com/repos";
const GITHUB_REPO_SEARCH_URL = "https://api.github.com/search/repositories";
const GITHUB_REPO_SUGGESTION_LIMIT = 5;
const GITHUB_RESOLVER_TIMEOUT = 10000;

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface RepoSuggestion {
  fullName: string;
  description?: string;
}

/**
 * Resolve repo locator from --repo or --url flags.
 */
function resolveRepo(args: string[]): string {
  const repoIndex = args.indexOf("--repo");
  const urlIndex = args.indexOf("--url");

  if (repoIndex !== -1 && urlIndex !== -1) {
    console.error("Error: provide either --repo or --url, not both");
    process.exit(1);
  }

  if (repoIndex === -1 && urlIndex === -1) {
    console.error("Error: --repo <owner/repo> or --url <github-url> is required");
    console.error(
      "Usage: morph github --repo <owner/repo> --query <text>",
    );
    process.exit(1);
  }

  if (repoIndex !== -1) {
    if (repoIndex + 1 >= args.length) {
      console.error("Error: --repo requires a value");
      process.exit(1);
    }
    const repo = args[repoIndex + 1]!;
    if (!OWNER_REPO_PATTERN.test(repo)) {
      console.error(
        `Error: --repo must be in "owner/repo" format, got: "${repo}"`,
      );
      process.exit(1);
    }
    return repo;
  }

  // --url
  if (urlIndex + 1 >= args.length) {
    console.error("Error: --url requires a value");
    process.exit(1);
  }

  const rawUrl = args[urlIndex + 1]!;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`Error: invalid URL: "${rawUrl}"`);
    process.exit(1);
    return ""; // unreachable, satisfies TS
  }

  if (!["github.com", "www.github.com"].includes(parsed.hostname)) {
    console.error(`Error: URL must point to github.com, got: "${parsed.hostname}"`);
    process.exit(1);
  }

  const pathParts = parsed.pathname
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  if (pathParts.length < 2) {
    console.error(
      `Error: URL must include both owner and repository name: "${rawUrl}"`,
    );
    process.exit(1);
  }

  const owner = pathParts[0]!;
  const repoName = pathParts[1]!.replace(/\.git$/, "");
  const canonical = `${owner}/${repoName}`;

  if (!OWNER_REPO_PATTERN.test(canonical)) {
    console.error(
      `Error: URL did not resolve to a valid owner/repo: "${rawUrl}"`,
    );
    process.exit(1);
  }

  return canonical;
}

/**
 * Fetch "Did you mean..." suggestions from GitHub Search API.
 */
async function fetchSuggestions(
  repo: string,
  query: string,
): Promise<RepoSuggestion[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_RESOLVER_TIMEOUT);

  try {
    const [owner, repoName] = repo.split("/");
    const searches = [
      repoName,
      `${repoName} user:${owner}`,
    ].filter(Boolean);

    const seen = new Set<string>();
    const suggestions: RepoSuggestion[] = [];

    for (const q of searches) {
      const url = new URL(GITHUB_REPO_SEARCH_URL);
      url.searchParams.set("q", q!);
      url.searchParams.set("sort", "stars");
      url.searchParams.set("order", "desc");
      url.searchParams.set("per_page", String(GITHUB_REPO_SUGGESTION_LIMIT));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "morph-cli",
        },
        signal: controller.signal,
      });

      if (!response.ok) continue;

      const body = (await response.json()) as {
        items?: Array<{
          full_name?: string;
          description?: string | null;
        }>;
      };

      for (const item of body.items || []) {
        if (item.full_name && !seen.has(item.full_name)) {
          seen.add(item.full_name);
          suggestions.push({
            fullName: item.full_name,
            description: item.description ?? undefined,
          });
        }
      }
    }

    return suggestions.slice(0, GITHUB_REPO_SUGGESTION_LIMIT);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a GitHub repo exists.
 */
async function checkRepoExists(repo: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_RESOLVER_TIMEOUT);

  try {
    const response = await fetch(`${GITHUB_REPO_API_URL}/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "morph-cli",
      },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // Network error -- proceed anyway, WarpGrep will report the real error
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format WarpGrep GitHub search results for CLI output.
 */
function formatResult(repo: string, result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed for ${repo}: ${result.error}`;
  }

  if (!result.contexts || result.contexts.length === 0) {
    return `No relevant code found in ${repo}. Try rephrasing your search term.`;
  }

  const parts: string[] = [];
  parts.push(`Repository: ${repo}`);
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

export async function runGithub(args: string[]): Promise<void> {
  const repo = resolveRepo(args);

  // Parse --query argument
  const queryIndex = args.indexOf("--query");
  if (queryIndex === -1 || queryIndex + 1 >= args.length) {
    console.error("Error: --query <text> is required");
    console.error(
      "Usage: morph github --repo <owner/repo> --query <text>",
    );
    process.exit(1);
  }

  const query = args[queryIndex + 1]!;

  const apiKey = process.env.MORPH_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: MORPH_API_KEY environment variable is required",
    );
    console.error("Get your API key at: https://morphllm.com/dashboard/api-keys");
    process.exit(1);
  }

  // Check if repo exists first
  const exists = await checkRepoExists(repo);
  if (!exists) {
    console.error(`Error: repository not found: ${repo}`);
    const suggestions = await fetchSuggestions(repo, query);
    if (suggestions.length > 0) {
      console.error("");
      console.error("Did you mean:");
      for (const s of suggestions) {
        const desc = s.description ? ` - ${s.description}` : "";
        console.error(`  ${s.fullName}${desc}`);
      }
    }
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
      searchTerm: query,
      github: repo,
    });

    const duration = Date.now() - startTime;
    const contextCount = result.contexts?.length ?? 0;

    if (!result.success) {
      // WarpGrep itself reported failure -- might be repo not indexed
      const suggestions = await fetchSuggestions(repo, query);
      console.error(`Error: search failed for ${repo}: ${result.error}`);
      if (suggestions.length > 0) {
        console.error("");
        console.error("Did you mean:");
        for (const s of suggestions) {
          const desc = s.description ? ` - ${s.description}` : "";
          console.error(`  ${s.fullName}${desc}`);
        }
      }
      process.exit(1);
    }

    console.log(formatResult(repo, result));
    console.error(
      `morph github: ${repo} ${contextCount} results (${duration}ms)`,
    );
  } catch (err) {
    const error = err as Error;
    const duration = Date.now() - startTime;
    console.error(
      `Error: GitHub search failed for ${repo} after ${duration}ms: ${error.message}`,
    );

    const suggestions = await fetchSuggestions(repo, query);
    if (suggestions.length > 0) {
      console.error("");
      console.error("Did you mean:");
      for (const s of suggestions) {
        const desc = s.description ? ` - ${s.description}` : "";
        console.error(`  ${s.fullName}${desc}`);
      }
    }
    process.exit(2);
  }
}

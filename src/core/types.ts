/**
 * Shared types and constants for the Morph CLI and plugin.
 */

// ---------------------------------------------------------------------------
// API / timeout constants
// ---------------------------------------------------------------------------

export const MORPH_API_URL = "https://api.morphllm.com";
export const MORPH_TIMEOUT = 30000;
export const MORPH_WARP_GREP_TIMEOUT = 60000;
export const GITHUB_RESOLVER_TIMEOUT = 10000;
export const GITHUB_REPO_API_URL = "https://api.github.com/repos";
export const GITHUB_REPO_SEARCH_URL = "https://api.github.com/search/repositories";
export const GITHUB_REPO_SUGGESTION_LIMIT = 5;

/** Plugin version — keep in sync with package.json */
export const PLUGIN_VERSION = "3.0.0";

/** Canonical marker string used for lazy edit placeholders */
export const EXISTING_CODE_MARKER = "// ... existing code ...";

/** Regex for validating GitHub owner/repo format */
export const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function getMorphApiKey(): string | undefined {
  return process.env.MORPH_API_KEY;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type GitHubRepo = string; // "owner/repo"

export type GitHubRepoSuggestion = {
  fullName: string;
  htmlUrl: string;
  description?: string;
  stars: number;
  ownerLogin: string;
  name: string;
};

export type GitHubRepoLookupResult =
  | {
      status: "found";
      fullName: string;
      defaultBranch?: string;
      htmlUrl?: string;
    }
  | {
      status: "not_found";
      detail: string;
    }
  | {
      status: "unavailable";
      detail: string;
    };

export type PublicRepoContextSearchArgs = {
  search_term: string;
  owner_repo?: string;
  github_url?: string;
  branch?: string;
};

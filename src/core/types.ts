/**
 * Shared types, constants, and feature flag helpers for the Morph plugin.
 *
 * Platform-agnostic — no imports from @opencode-ai/plugin or @opencode-ai/sdk.
 */

// ---------------------------------------------------------------------------
// API / timeout constants
// ---------------------------------------------------------------------------

export const MORPH_API_URL = "https://api.morphllm.com";
export const MORPH_TIMEOUT = 30000;
export const MORPH_WARP_GREP_TIMEOUT = 60000;
export const MORPH_COMPACT_TIMEOUT = 60000;
export const GITHUB_RESOLVER_TIMEOUT = 10000;
export const GITHUB_REPO_API_URL = "https://api.github.com/repos";
export const GITHUB_REPO_SEARCH_URL = "https://api.github.com/search/repositories";
export const GITHUB_REPO_SUGGESTION_LIMIT = 5;

// Compaction constants
export const CHARS_PER_TOKEN = 3;

/** Plugin version */
export const PLUGIN_VERSION = "2.0.0";

/** Canonical marker string used for lazy edit placeholders */
export const EXISTING_CODE_MARKER = "// ... existing code ...";

/** Header used in system routing hints */
export const MORPH_ROUTING_HINT_HEADER = "Morph plugin routing hints:";

/** Agents that are blocked from using morph_edit by default */
export const READONLY_AGENTS = ["plan", "explore"];

/** Regex for validating GitHub owner/repo format */
export const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// Feature flags — users can disable specific capabilities
// ---------------------------------------------------------------------------

export function isMorphEditEnabled(): boolean {
  return process.env.MORPH_EDIT !== "false";
}

export function isMorphWarpgrepEnabled(): boolean {
  return process.env.MORPH_WARPGREP !== "false";
}

export function isMorphWarpgrepGithubEnabled(): boolean {
  return process.env.MORPH_WARPGREP_GITHUB !== "false";
}

export function isMorphCompactEnabled(): boolean {
  return process.env.MORPH_COMPACT !== "false";
}

export function isAllowReadonlyAgents(): boolean {
  return process.env.MORPH_ALLOW_READONLY_AGENTS === "true";
}

export function getMorphApiKey(): string | undefined {
  return process.env.MORPH_API_KEY;
}

export function getCompactContextThreshold(): number {
  return parseFloat(process.env.MORPH_COMPACT_CONTEXT_THRESHOLD || "0.7");
}

export function getCompactPreserveRecent(): number {
  return parseInt(process.env.MORPH_COMPACT_PRESERVE_RECENT || "6", 10);
}

export function getCompactRatio(): number {
  return parseFloat(process.env.MORPH_COMPACT_RATIO || "0.3");
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

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

import { isAbsolute, resolve as resolvePath } from "node:path";

export function resolveSessionFilepath(
  targetFilepath: string,
  sessionDirectory: string,
): string {
  return isAbsolute(targetFilepath)
    ? targetFilepath
    : resolvePath(sessionDirectory, targetFilepath);
}

export function resolveSessionRepoRoot(
  sessionDirectory: string,
  sessionWorktree: string,
): string {
  return sessionWorktree || sessionDirectory;
}

// ---------------------------------------------------------------------------
// Tool description helpers
// ---------------------------------------------------------------------------

export function appendRuntimeNotes(description: string, notes: string[]): string {
  if (notes.length === 0) return description;

  return `${description}\n\nRuntime notes:\n${notes.map((note) => `- ${note}`).join("\n")}`;
}

export function buildToolRuntimeNotes(
  toolID: string,
  morphApiKey: string | undefined,
  allowReadonlyAgents: boolean,
): string[] {
  switch (toolID) {
    case "morph_edit": {
      const notes = [
        "Relative paths resolve from the active session directory.",
      ];

      if (!allowReadonlyAgents) {
        notes.push(
          `Blocked in readonly agents: ${READONLY_AGENTS.join(", ")}.`,
        );
      }

      if (!morphApiKey) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    case "warpgrep_codebase_search": {
      const notes = [
        "Searches the current project worktree, not just the immediate cwd.",
      ];

      if (!morphApiKey) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    case "warpgrep_github_search": {
      const notes = [
        "Use this for public GitHub source questions, not the current checked-out repo.",
      ];

      if (!morphApiKey) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    default:
      return [];
  }
}

export function buildMorphSystemRoutingHint(
  morphApiKey: string | undefined,
  editEnabled: boolean,
  warpgrepEnabled: boolean,
  warpgrepGithubEnabled: boolean,
  allowReadonlyAgents: boolean,
): string | null {
  if (!morphApiKey) {
    return [
      MORPH_ROUTING_HINT_HEADER,
      "- Morph remote tools are currently unavailable because MORPH_API_KEY is not configured.",
      "- Use native edit/write/grep tools until Morph credentials are configured.",
    ].join("\n");
  }

  const lines = [MORPH_ROUTING_HINT_HEADER];

  if (editEnabled) {
    lines.push(
      "- Prefer morph_edit for large or scattered edits inside existing files.",
    );
    lines.push("- Use native edit for small exact replacements.");
    lines.push("- Use write for brand new files.");

    if (!allowReadonlyAgents) {
      lines.push(
        `- morph_edit is blocked in readonly agents: ${READONLY_AGENTS.join(", ")}.`,
      );
    }
  }

  if (warpgrepEnabled) {
    lines.push(
      "- Use warpgrep_codebase_search for exploratory local codebase questions.",
    );
  }

  if (warpgrepGithubEnabled) {
    lines.push(
      "- Use warpgrep_github_search for public GitHub source questions.",
    );
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

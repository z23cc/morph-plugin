import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompactClient } from "@morphllm/morphsdk";

// These are internal to the plugin but duplicated here for testing.
// Keep in sync with index.ts.
const EXISTING_CODE_MARKER = "// ... existing code ...";

function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 3) return codeEdit;
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (/^```[\w-]*$/.test(firstLine!) && /^```$/.test(lastLine!)) {
    return lines.slice(1, -1).join("\n");
  }
  return codeEdit;
}

type PublicRepoContextSearchArgs = {
  search_term: string;
  owner_repo?: string;
  github_url?: string;
  branch?: string;
};

type ResolvedPublicRepoLocator = {
  github: string;
  display: string;
};

type GitHubRepoSuggestion = {
  fullName: string;
  htmlUrl: string;
  description?: string;
  stars: number;
  ownerLogin: string;
  name: string;
};

const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GENERIC_REPO_TOKENS = new Set([
  "app",
  "client",
  "code",
  "core",
  "docs",
  "js",
  "kit",
  "lib",
  "node",
  "package",
  "packages",
  "protocol",
  "repo",
  "repository",
  "sdk",
  "server",
  "solana",
  "ts",
  "typescript",
  "web",
]);
const GENERIC_SEARCH_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "auth",
  "create",
  "does",
  "end",
  "explain",
  "features",
  "find",
  "flow",
  "for",
  "from",
  "how",
  "in",
  "is",
  "main",
  "offer",
  "offers",
  "of",
  "on",
  "order",
  "packages",
  "placement",
  "repo",
  "repository",
  "the",
  "this",
  "to",
  "what",
  "work",
  "works",
]);

function tokenizeResolverText(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function splitRepoLocator(locator: string): { owner?: string; repo?: string } {
  const parts = locator.split("/");
  if (parts.length !== 2) return {};
  return {
    owner: parts[0]?.toLowerCase(),
    repo: parts[1]?.toLowerCase(),
  };
}

function buildPublicRepoResolverQueries(
  repo: ResolvedPublicRepoLocator,
  searchTerm: string,
): string[] {
  const { owner, repo: repoName } = splitRepoLocator(repo.github);
  const meaningfulSearchTokens = tokenizeResolverText(searchTerm)
    .filter((token) => !GENERIC_SEARCH_TERMS.has(token))
    .slice(0, 4);
  const repoTokens = tokenizeResolverText(repo.github).filter(
    (token) => !GENERIC_REPO_TOKENS.has(token),
  );

  const queries = new Set<string>();

  if (owner) {
    queries.add(`user:${owner}`);
    if (meaningfulSearchTokens.length > 0) {
      queries.add(`user:${owner} ${meaningfulSearchTokens.join(" ")}`);
    }
  }

  const broadTokens = [...repoTokens, ...meaningfulSearchTokens].slice(0, 6);
  if (broadTokens.length > 0) {
    queries.add(broadTokens.join(" "));
  }

  if (repoName && !GENERIC_REPO_TOKENS.has(repoName)) {
    queries.add(repoName);
  }

  return Array.from(queries);
}

function computeGitHubSuggestionScore(
  suggestion: GitHubRepoSuggestion,
  repo: ResolvedPublicRepoLocator,
  searchTerm: string,
): number {
  const { owner, repo: repoName } = splitRepoLocator(repo.github);
  const fullName = suggestion.fullName.toLowerCase();
  const name = suggestion.name.toLowerCase();
  const description = (suggestion.description || "").toLowerCase();
  const haystack = `${fullName} ${description}`;
  const searchTokens = tokenizeResolverText(searchTerm).filter(
    (token) => !GENERIC_SEARCH_TERMS.has(token),
  );

  let score = Math.log10(suggestion.stars + 1);

  if (owner && suggestion.ownerLogin.toLowerCase() === owner) score += 8;
  if (repoName && name === repoName) score += 6;
  if (repoName && !GENERIC_REPO_TOKENS.has(repoName) && name.includes(repoName)) {
    score += 3;
  }
  if (fullName === repo.github.toLowerCase()) score += 20;

  for (const token of searchTokens.slice(0, 4)) {
    if (haystack.includes(token)) score += 1.5;
  }

  return score;
}

function classifyPublicRepoSearchError(error: string): "not_found" | "other" {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("not found") ||
    normalized.includes("404") ||
    normalized.includes("does not exist") ||
    normalized.includes("could not resolve") ||
    normalized.includes("failed to resolve") ||
    normalized.includes("repository resolution")
  ) {
    return "not_found";
  }
  return "other";
}

function formatPublicRepoResolutionFailure(
  repo: ResolvedPublicRepoLocator,
  detail?: string,
  suggestions: GitHubRepoSuggestion[] = [],
): string {
  const extra = detail ? `\n\nResolver detail: ${detail}` : "";
  const suggestionBlock =
    suggestions.length === 0
      ? ""
      : `\n\nDid you mean:\n${suggestions
          .map((suggestion) => {
            const description = suggestion.description
              ? ` - ${suggestion.description}`
              : "";
            return `- ${suggestion.fullName}${description}`;
          })
          .join("\n")}\n\nSuggested next step:\nRetry public_repo_context_search with owner_repo="${suggestions[0]!.fullName}".`;
  return `Repository resolution failed for ${repo.display}.

This locator did not resolve to a public GitHub repository that Morph can search.${extra}${suggestionBlock}

Try:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"
- verify the owner and repo spelling
- use the canonical upstream repository instead of a package name or import path

Examples:
- anza-xyz/kit
- facebook/react
- vercel/next.js`;
}

function resolvePublicRepoLocator(
  args: PublicRepoContextSearchArgs,
): { repo: ResolvedPublicRepoLocator } | { error: string } {
  const ownerRepo = args.owner_repo?.trim();
  const githubUrl = args.github_url?.trim();

  if (ownerRepo && githubUrl) {
    return {
      error: `Error: Provide either owner_repo or github_url, not both.

Use owner_repo for values like "facebook/react" or github_url for full URLs like "https://github.com/facebook/react".`,
    };
  }

  if (!ownerRepo && !githubUrl) {
    return {
      error: `Error: Missing repository target.

Provide exactly one of:
- owner_repo: "facebook/react"
- github_url: "https://github.com/facebook/react"`,
    };
  }

  if (ownerRepo) {
    if (!GITHUB_OWNER_REPO_PATTERN.test(ownerRepo)) {
      return {
        error: `Error: owner_repo must be a GitHub repository in "owner/repo" format.

Received: "${ownerRepo}"

Examples:
- "facebook/react"
- "vercel/next.js"
- "anza-xyz/kit"

If you have a full URL, use github_url instead.`,
      };
    }

    return {
      repo: {
        github: ownerRepo,
        display: ownerRepo,
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(githubUrl!);
  } catch {
    return {
      error: `Error: github_url must be a valid GitHub repository URL.

Received: "${githubUrl}"

Example:
- "https://github.com/facebook/react"`,
    };
  }

  if (!["github.com", "www.github.com"].includes(parsed.hostname)) {
    return {
      error: `Error: github_url must point to github.com.

Received host: "${parsed.hostname}"

Example:
- "https://github.com/facebook/react"`,
    };
  }

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (pathParts.length < 2) {
    return {
      error: `Error: github_url must include both owner and repository name.

Received: "${githubUrl}"

Example:
- "https://github.com/facebook/react"`,
    };
  }

  const owner = pathParts[0]!;
  const repoName = pathParts[1]!.replace(/\.git$/, "");
  const canonicalRepo = `${owner}/${repoName}`;

  if (!GITHUB_OWNER_REPO_PATTERN.test(canonicalRepo)) {
    return {
      error: `Error: github_url did not resolve to a valid GitHub owner/repo locator.

Received: "${githubUrl}"`,
    };
  }

  return {
    repo: {
      github: canonicalRepo,
      display: canonicalRepo,
    },
  };
}

describe("EXISTING_CODE_MARKER", () => {
  test("is the canonical marker string", () => {
    expect(EXISTING_CODE_MARKER).toBe("// ... existing code ...");
  });
});

describe("packaged tool-selection instructions", () => {
  test("instruction file exists and routes large edits to morph_edit", () => {
    const content = readFileSync(
      join(import.meta.dir, "instructions", "morph-tools.md"),
      "utf-8",
    );

    expect(content).toContain("Morph Tool Selection Policy");
    expect(content).toContain("canonical always-on routing policy for Morph tools");
    expect(content).toContain("~/.config/opencode/instructions/morph-tools.md");
    expect(content).toContain("Large file edits (300+ lines)");
    expect(content).toContain("`morph_edit`");
    expect(content).toContain("Small exact replacement");
    expect(content).toContain("`edit`");
    expect(content).toContain("New file creation");
    expect(content).toContain("`write`");
    expect(content).toContain("`public_repo_context_search`");
    expect(content).toContain("Public GitHub repo exploration");
    expect(content).toContain("Tool Exposure Requirement");
    expect(content).toContain("morph_edit: true");
  });

  test("README documents plugin setup and tools", () => {
    const content = readFileSync(join(import.meta.dir, "README.md"), "utf-8");

    expect(content).toContain(
      "~/.config/opencode/instructions/morph-tools.md",
    );
    expect(content).toContain("morph_edit");
    expect(content).toContain("warpgrep_codebase_search");
    expect(content).toContain("public_repo_context_search");
    expect(content).toContain("MORPH_API_KEY");
    expect(content).toContain("MORPH_PUBLIC_REPO_CONTEXT_SEARCH");
    expect(content).toContain("Safety guards");
  });
});

describe("resolvePublicRepoLocator", () => {
  test("accepts owner_repo", () => {
    expect(
      resolvePublicRepoLocator({
        search_term: "How do hooks work?",
        owner_repo: "facebook/react",
      }),
    ).toEqual({ repo: { github: "facebook/react", display: "facebook/react" } });
  });

  test("accepts github_url", () => {
    expect(
      resolvePublicRepoLocator({
        search_term: "How do hooks work?",
        github_url: "https://github.com/facebook/react",
      }),
    ).toEqual({ repo: { github: "facebook/react", display: "facebook/react" } });
  });

  test("trims surrounding whitespace", () => {
    expect(
      resolvePublicRepoLocator({
        search_term: "How do hooks work?",
        owner_repo: "  facebook/react  ",
      }),
    ).toEqual({ repo: { github: "facebook/react", display: "facebook/react" } });
  });

  test("normalizes github_url with .git suffix", () => {
    expect(
      resolvePublicRepoLocator({
        search_term: "How do hooks work?",
        github_url: "https://github.com/facebook/react.git",
      }),
    ).toEqual({ repo: { github: "facebook/react", display: "facebook/react" } });
  });

  test("accepts github_url with extra path segments", () => {
    expect(
      resolvePublicRepoLocator({
        search_term: "How do hooks work?",
        github_url: "https://github.com/facebook/react/tree/main/packages/react",
      }),
    ).toEqual({ repo: { github: "facebook/react", display: "facebook/react" } });
  });

  test("rejects both owner_repo and github_url", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
      owner_repo: "facebook/react",
      github_url: "https://github.com/facebook/react",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("either owner_repo or github_url");
    }
  });

  test("rejects missing repository target", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Missing repository target");
    }
  });

  test("rejects whitespace-only repository values", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
      owner_repo: "   ",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Missing repository target");
    }
  });

  test("rejects invalid owner_repo format", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
      owner_repo: "@solana/kit",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('owner_repo must be a GitHub repository in "owner/repo" format');
    }
  });

  test("rejects non-github url hosts", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
      github_url: "https://npmjs.com/package/react",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("must point to github.com");
    }
  });

  test("rejects github urls without repo name", () => {
    const result = resolvePublicRepoLocator({
      search_term: "How do hooks work?",
      github_url: "https://github.com/facebook",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("must include both owner and repository name");
    }
  });
});

describe("public repo resolution failures", () => {
  test("classifies repository not found errors", () => {
    expect(classifyPublicRepoSearchError("Repository not found")).toBe("not_found");
    expect(classifyPublicRepoSearchError("404 from upstream")).toBe("not_found");
    expect(classifyPublicRepoSearchError("Failed to resolve repository")).toBe("not_found");
  });

  test("does not classify generic query failures as missing repo", () => {
    expect(classifyPublicRepoSearchError("timeout talking to upstream")).toBe("other");
  });

  test("formats a retry-friendly repository resolution failure", () => {
    const output = formatPublicRepoResolutionFailure(
      { github: "solana-fm/solana-kit", display: "solana-fm/solana-kit" },
      "Repository not found",
    );

    expect(output).toContain("Repository resolution failed for solana-fm/solana-kit");
    expect(output).toContain("This locator did not resolve to a public GitHub repository");
    expect(output).toContain("canonical upstream repository");
    expect(output).toContain("Resolver detail: Repository not found");
    expect(output).toContain("anza-xyz/kit");
  });

  test("formats suggestion candidates and a retry target", () => {
    const output = formatPublicRepoResolutionFailure(
      { github: "drift-labs/sdk", display: "drift-labs/sdk" },
      "Repository not found",
      [
        {
          fullName: "drift-labs/protocol-v2",
          htmlUrl: "https://github.com/drift-labs/protocol-v2",
          description: "Drift Protocol v2 monorepo",
          stars: 100,
          ownerLogin: "drift-labs",
          name: "protocol-v2",
        },
      ],
    );

    expect(output).toContain("Did you mean:");
    expect(output).toContain("drift-labs/protocol-v2 - Drift Protocol v2 monorepo");
    expect(output).toContain(
      'Retry public_repo_context_search with owner_repo="drift-labs/protocol-v2"',
    );
  });
});

describe("public repo resolver queries", () => {
  test("builds owner-scoped and broad fallback queries", () => {
    const queries = buildPublicRepoResolverQueries(
      { github: "drift-labs/sdk", display: "drift-labs/sdk" },
      "How does order placement work end to end?",
    );

    expect(queries).toContain("user:drift-labs");
    expect(queries.some((query) => query !== "user:drift-labs")).toBe(true);
    expect(queries.some((query) => query.includes("drift"))).toBe(true);
  });

  test("ranks exact-owner suggestions above generic higher-star repos", () => {
    const repo = { github: "drift-labs/sdk", display: "drift-labs/sdk" };
    const searchTerm = "How does order placement work end to end?";
    const ownerMatch = {
      fullName: "drift-labs/protocol-v2",
      htmlUrl: "https://github.com/drift-labs/protocol-v2",
      description: "Drift Protocol v2 monorepo",
      stars: 800,
      ownerLogin: "drift-labs",
      name: "protocol-v2",
    };
    const genericHigherStar = {
      fullName: "somebody/sdk",
      htmlUrl: "https://github.com/somebody/sdk",
      description: "Generic SDK",
      stars: 50000,
      ownerLogin: "somebody",
      name: "sdk",
    };

    expect(
      computeGitHubSuggestionScore(ownerMatch, repo, searchTerm),
    ).toBeGreaterThan(
      computeGitHubSuggestionScore(genericHigherStar, repo, searchTerm),
    );
  });
});

describe("normalizeCodeEditInput", () => {
  test("returns plain code unchanged", () => {
    const input = `${EXISTING_CODE_MARKER}\nfunction foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("strips standard markdown fence with language", () => {
    const input = "```typescript\nfunction foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe("function foo() { return 1 }");
  });

  test("strips markdown fence without language", () => {
    const input = "```\nfunction foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe("function foo() { return 1 }");
  });

  test("preserves multi-line content inside fences", () => {
    const inner = `${EXISTING_CODE_MARKER}\nfunction foo() {\n  return 1\n}\n${EXISTING_CODE_MARKER}`;
    const input = `\`\`\`typescript\n${inner}\n\`\`\``;
    expect(normalizeCodeEditInput(input)).toBe(inner);
  });

  test("does not strip incomplete fences (missing closing)", () => {
    const input = "```typescript\nfunction foo() { return 1 }";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("does not strip incomplete fences (missing opening)", () => {
    const input = "function foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("returns short input unchanged (< 3 lines)", () => {
    expect(normalizeCodeEditInput("hello")).toBe("hello");
    expect(normalizeCodeEditInput("line1\nline2")).toBe("line1\nline2");
  });

  test("handles fence with hyphenated language", () => {
    const input = "```c-sharp\nConsole.WriteLine();\n```";
    expect(normalizeCodeEditInput(input)).toBe("Console.WriteLine();");
  });

  test("does not strip fences with text after closing", () => {
    const input = "```typescript\nfoo()\n``` extra text";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("trims whitespace before checking fences", () => {
    const input = "  \n```typescript\nfunction foo() {}\n```\n  ";
    expect(normalizeCodeEditInput(input)).toBe("function foo() {}");
  });

  test("returns empty string unchanged", () => {
    expect(normalizeCodeEditInput("")).toBe("");
  });

  test("handles fence with only whitespace content", () => {
    const input = "```\n  \n```";
    expect(normalizeCodeEditInput(input)).toBe("  ");
  });

  test("handles javascript language tag", () => {
    const input = "```javascript\nconst x = 1;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = 1;");
  });

  test("handles python language tag", () => {
    const input = "```python\ndef foo():\n    pass\n```";
    expect(normalizeCodeEditInput(input)).toBe("def foo():\n    pass");
  });

  test("does not strip if closing fence has language", () => {
    // Invalid markdown: closing fence should not have a language
    const input = "```typescript\nfoo()\n```typescript";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("preserves content with backticks inside fences", () => {
    const input = "```typescript\nconst x = `hello ${world}`;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = `hello ${world}`;");
  });
});

describe("marker leakage detection logic", () => {
  test("detected when original lacks marker", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}\nfunction bar() {}`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("skipped when original already contains marker", () => {
    const originalCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code`;
    const mergedCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code\n// Added line`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  test("not triggered when no markers in input", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    const hasMarkers = false;

    const wouldTrigger =
      hasMarkers && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  test("detected when marker appears at start of merged output", () => {
    const originalCode = "const x = 1;\nconst y = 2;";
    const mergedCode = `${EXISTING_CODE_MARKER}\nconst x = 1;\nconst y = 2;`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("detected when marker appears at end of merged output", () => {
    const originalCode = "const x = 1;\nconst y = 2;";
    const mergedCode = `const x = 1;\nconst y = 2;\n${EXISTING_CODE_MARKER}`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("not triggered on clean merge (no markers in output)", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = "function foo() { return 2 }";
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });
});

describe("truncation detection logic", () => {
  // Helper to simulate the guard condition
  function wouldTriggerTruncation(
    originalCode: string,
    mergedCode: string,
    hasMarkers: boolean,
  ): { triggered: boolean; charLoss: number; lineLoss: number } {
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

  test("triggers when both char and line loss exceed thresholds", () => {
    const originalCode = "x".repeat(1000) + "\n".repeat(100);
    const mergedCode = "x".repeat(300) + "\n".repeat(40);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(true);
  });

  test("does not trigger when only char loss exceeds threshold", () => {
    // Lots of char loss but lines stay similar (whitespace removal)
    const originalCode = "x    ".repeat(200) + "\n".repeat(50);
    const mergedCode = "x".repeat(200) + "\n".repeat(50);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
    expect(result.lineLoss).toBeLessThanOrEqual(0.5);
  });

  test("does not trigger when only line loss exceeds threshold", () => {
    // Lines shrunk but chars stayed similar (joined multi-line to single-line)
    const lines = Array.from({ length: 100 }, () => "ab").join("\n");
    const joined = Array.from({ length: 40 }, () => "ab".repeat(3)).join("\n");

    const result = wouldTriggerTruncation(lines, joined, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
  });

  test("does not trigger when no markers in input", () => {
    const originalCode = "x".repeat(1000) + "\n".repeat(100);
    const mergedCode = "x".repeat(100);

    const result = wouldTriggerTruncation(originalCode, mergedCode, false);
    expect(result.triggered).toBe(false);
  });

  test("does not trigger when file grows (negative loss)", () => {
    const originalCode = "short\nfile\n";
    const mergedCode = "short\nfile\nwith\nmany\nnew\nlines\nadded\nhere\n";

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThan(0);
    expect(result.lineLoss).toBeLessThan(0);
  });

  test("does not trigger on empty original file", () => {
    const originalCode = "";
    const mergedCode = "new content";

    // Edge: division by zero for charLoss/lineLoss produces NaN/Infinity
    const originalLineCount = originalCode.split("\n").length;
    const mergedLineCount = mergedCode.split("\n").length;
    const charLoss =
      (originalCode.length - mergedCode.length) / originalCode.length;
    const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;

    // NaN > 0.6 is false, so this should NOT trigger
    const triggered = true && charLoss > 0.6 && lineLoss > 0.5;
    expect(triggered).toBe(false);
  });

  test("triggers just above both thresholds", () => {
    // original: 1000 chars, merged: 390 chars → charLoss = 0.61
    // original: 100 lines, merged: 49 lines → lineLoss = 0.51
    const originalCode = "x".repeat(900) + "\n".repeat(100);
    const mergedCode = "x".repeat(341) + "\n".repeat(49);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeGreaterThan(0.6);
    expect(result.lineLoss).toBeGreaterThan(0.5);
    expect(result.triggered).toBe(true);
  });

  test("does not trigger when just below char threshold", () => {
    // original: 1000 chars, merged: 401 chars → charLoss = 0.599
    // original: 100 lines, merged: 10 lines → lineLoss = 0.90
    const originalCode = "x".repeat(900) + "\n".repeat(100);
    const mergedCode = "x".repeat(391) + "\n".repeat(10);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
    expect(result.triggered).toBe(false);
  });

  test("handles single-line file correctly", () => {
    const originalCode = "x".repeat(100);
    const mergedCode = "x".repeat(10);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    // lineLoss = (1-1)/1 = 0, which is below 0.5
    expect(result.lineLoss).toBe(0);
    expect(result.triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compaction helper functions — duplicated from index.ts for testing
// ---------------------------------------------------------------------------

type FakePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: any }
  | { type: "reasoning"; text: string }
  | { type: "step-start" }
  | { type: "file"; filename: string };

type FakeMessage = {
  info: { id: string; role: "user" | "assistant"; sessionID: string };
  parts: FakePart[];
};

function serializePart(part: FakePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool": {
      const state = part.state;
      if (state.status === "completed") {
        const inputStr = JSON.stringify(state.input).slice(0, 500);
        const outputStr = (state.output || "").slice(0, 2000);
        return `[Tool: ${part.tool}] ${inputStr}\nOutput: ${outputStr}`;
      }
      if (state.status === "error") {
        return `[Tool: ${part.tool}] Error: ${state.error}`;
      }
      return `[Tool: ${part.tool}] ${state.status}`;
    }
    case "reasoning":
      return `[Reasoning] ${part.text}`;
    default:
      return `[${part.type}]`;
  }
}

function messagesToCompactInput(
  messages: FakeMessage[],
): { role: string; content: string }[] {
  return messages
    .map((m) => ({
      role: m.info.role,
      content: m.parts.map(serializePart).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

function estimateTotalChars(messages: FakeMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += part.text.length;
      else if (part.type === "tool") {
        if (part.state.status === "completed") {
          total += (part.state.output || "").length;
          total += JSON.stringify(part.state.input).length;
        }
      }
    }
  }
  return total;
}

function hashMessageIds(messages: { info: { id: string } }[]): string {
  return messages.map((m) => m.info.id).join("|");
}

// Helpers to build fake messages for tests
function makeTextMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
): FakeMessage {
  return {
    info: { id, role, sessionID: "sess-1" },
    parts: [{ type: "text", text }],
  };
}

function makeToolMsg(
  id: string,
  toolName: string,
  input: any,
  output: string,
): FakeMessage {
  return {
    info: { id, role: "assistant", sessionID: "sess-1" },
    parts: [
      {
        type: "tool",
        tool: toolName,
        state: { status: "completed", input, output },
      },
    ],
  };
}

describe("serializePart", () => {
  test("serializes text part", () => {
    expect(serializePart({ type: "text", text: "hello world" })).toBe(
      "hello world",
    );
  });

  test("serializes completed tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "/foo.ts" },
        output: "file contents here",
      },
    });
    expect(result).toContain("[Tool: read]");
    expect(result).toContain("/foo.ts");
    expect(result).toContain("Output: file contents here");
  });

  test("serializes error tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "write",
      state: { status: "error", error: "permission denied" },
    });
    expect(result).toBe("[Tool: write] Error: permission denied");
  });

  test("serializes pending tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "edit",
      state: { status: "pending" },
    });
    expect(result).toBe("[Tool: edit] pending");
  });

  test("serializes reasoning part", () => {
    expect(
      serializePart({ type: "reasoning", text: "thinking about this..." }),
    ).toBe("[Reasoning] thinking about this...");
  });

  test("serializes unknown part type as bracket marker", () => {
    expect(serializePart({ type: "step-start" } as FakePart)).toBe(
      "[step-start]",
    );
    expect(
      serializePart({ type: "file", filename: "foo.ts" } as FakePart),
    ).toBe("[file]");
  });

  test("truncates long tool input to 500 chars", () => {
    const longInput = { data: "x".repeat(1000) };
    const result = serializePart({
      type: "tool",
      tool: "search",
      state: { status: "completed", input: longInput, output: "ok" },
    });
    const toolLine = result.split("\n")[0]!;
    // The JSON.stringify(input).slice(0, 500) should truncate
    const inputPart = toolLine.replace("[Tool: search] ", "");
    expect(inputPart.length).toBeLessThanOrEqual(500);
  });

  test("truncates long tool output to 2000 chars", () => {
    const longOutput = "y".repeat(5000);
    const result = serializePart({
      type: "tool",
      tool: "read",
      state: { status: "completed", input: {}, output: longOutput },
    });
    const outputLine = result.split("\n").slice(1).join("\n");
    const outputPart = outputLine.replace("Output: ", "");
    expect(outputPart.length).toBeLessThanOrEqual(2000);
  });
});

describe("messagesToCompactInput", () => {
  test("converts text messages to role/content pairs", () => {
    const messages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi there"),
    ];
    const result = messagesToCompactInput(messages);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  test("filters out messages with empty content", () => {
    const messages: FakeMessage[] = [
      makeTextMsg("1", "user", "hello"),
      { info: { id: "2", role: "assistant", sessionID: "s" }, parts: [] },
    ];
    const result = messagesToCompactInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("hello");
  });

  test("joins multiple parts with newlines", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "text", text: "Let me check" },
        {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/a.ts" },
            output: "contents",
          },
        },
        { type: "text", text: "Done" },
      ],
    };
    const result = messagesToCompactInput([msg]);
    expect(result[0]!.content).toContain("Let me check");
    expect(result[0]!.content).toContain("[Tool: read]");
    expect(result[0]!.content).toContain("Done");
  });
});

describe("estimateTotalChars", () => {
  test("counts text part characters", () => {
    const messages = [
      makeTextMsg("1", "user", "hello"), // 5 chars
      makeTextMsg("2", "assistant", "world!"), // 6 chars
    ];
    expect(estimateTotalChars(messages)).toBe(11);
  });

  test("counts completed tool input + output", () => {
    const messages = [makeToolMsg("1", "read", { path: "/a" }, "contents")];
    // JSON.stringify({path:"/a"}) = '{"path":"/a"}' = 13 chars
    // "contents" = 8 chars
    expect(estimateTotalChars(messages)).toBe(13 + 8);
  });

  test("ignores non-completed tool parts", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "tool", tool: "edit", state: { status: "pending" } },
        {
          type: "tool",
          tool: "write",
          state: { status: "error", error: "fail" },
        },
      ],
    };
    expect(estimateTotalChars([msg])).toBe(0);
  });

  test("ignores non-text non-tool parts", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "reasoning", text: "this is long reasoning" },
        { type: "step-start" } as FakePart,
      ],
    };
    expect(estimateTotalChars([msg])).toBe(0);
  });

  test("returns 0 for empty messages", () => {
    expect(estimateTotalChars([])).toBe(0);
  });
});

describe("hashMessageIds", () => {
  test("joins message IDs with pipe", () => {
    const messages = [
      { info: { id: "abc" } },
      { info: { id: "def" } },
      { info: { id: "ghi" } },
    ];
    expect(hashMessageIds(messages)).toBe("abc|def|ghi");
  });

  test("returns empty string for empty array", () => {
    expect(hashMessageIds([])).toBe("");
  });

  test("handles single message", () => {
    expect(hashMessageIds([{ info: { id: "only" } }])).toBe("only");
  });
});

describe("compaction integration", () => {
  const MORPH_API_KEY = process.env.MORPH_API_KEY;

  test("CompactClient.compact() returns valid result", async () => {
    if (!MORPH_API_KEY) {
      console.log("Skipping: MORPH_API_KEY not set");
      return;
    }

    const client = new CompactClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: "https://api.morphllm.com",
      timeout: 30000,
    });

    const messages = [
      {
        role: "user",
        content:
          "I want to refactor the authentication module. Currently it uses JWT tokens stored in localStorage, but I want to switch to httpOnly cookies for better security. The auth flow starts in src/auth/login.ts where we call the /api/auth/login endpoint, get back a token, and store it. Then in src/middleware/auth.ts we read the token from the Authorization header.",
      },
      {
        role: "assistant",
        content:
          "I'll help you refactor the authentication from JWT localStorage to httpOnly cookies. Let me first examine the current implementation.\n\n[Tool: read] {\"path\":\"src/auth/login.ts\"}\nOutput: import { api } from '../api';\n\nexport async function login(email: string, password: string) {\n  const response = await api.post('/api/auth/login', { email, password });\n  const { token } = response.data;\n  localStorage.setItem('auth_token', token);\n  return response.data.user;\n}\n\n[Tool: read] {\"path\":\"src/middleware/auth.ts\"}\nOutput: import { NextFunction, Request, Response } from 'express';\n\nexport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n  // verify token...\n  next();\n}\n\nI can see the current flow. Here's my plan:\n1. Modify the login endpoint to set httpOnly cookies instead of returning tokens\n2. Update the middleware to read from cookies instead of Authorization header\n3. Add CSRF protection since we're switching to cookies",
      },
      {
        role: "user",
        content: "Sounds good, go ahead with the changes.",
      },
      {
        role: "assistant",
        content:
          "Let me apply the changes.\n\n[Tool: edit] {\"path\":\"src/auth/login.ts\"}\nOutput: Applied edit successfully.\n\n[Tool: edit] {\"path\":\"src/middleware/auth.ts\"}\nOutput: Applied edit successfully.\n\nI've updated both files. The login function now expects the server to set an httpOnly cookie, and the middleware reads from req.cookies instead of the Authorization header.",
      },
    ];

    const result = await client.compact({
      messages,
      compressionRatio: 0.5,
      preserveRecent: 1,
    });

    expect(result).toBeDefined();
    expect(result.output).toBeDefined();
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.length).toBeLessThan(
      messages.map((m) => m.content).join("").length,
    );
    expect(result.usage).toBeDefined();
    expect(result.usage.compression_ratio).toBeGreaterThan(0);
    expect(result.usage.compression_ratio).toBeLessThanOrEqual(1);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);

  test("proactive compaction threshold logic", () => {
    // Simulate the decision flow from experimental.chat.messages.transform
    const THRESHOLD = 140000;
    const PRESERVE_RECENT = 6;

    // Below threshold — no compaction
    const smallMessages = Array.from({ length: 20 }, (_, i) =>
      makeTextMsg(`msg-${i}`, i % 2 === 0 ? "user" : "assistant", "short"),
    );
    expect(estimateTotalChars(smallMessages)).toBeLessThan(THRESHOLD);

    // Above threshold — compaction should trigger
    const largeMessages = Array.from({ length: 20 }, (_, i) =>
      makeTextMsg(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "x".repeat(8000),
      ),
    );
    expect(estimateTotalChars(largeMessages)).toBeGreaterThan(THRESHOLD);

    // Split preserves recent messages
    const older = largeMessages.slice(0, -PRESERVE_RECENT);
    const recent = largeMessages.slice(-PRESERVE_RECENT);
    expect(older.length).toBe(14);
    expect(recent.length).toBe(PRESERVE_RECENT);

    // Input conversion produces non-empty content
    const compactInput = messagesToCompactInput(older);
    expect(compactInput.length).toBe(14);
    expect(compactInput.every((m) => m.content.length > 0)).toBe(true);

    // Hash is stable
    const hash1 = hashMessageIds(older);
    const hash2 = hashMessageIds(older);
    expect(hash1).toBe(hash2);

    // Hash changes when messages change
    const differentOlder = [
      ...older.slice(0, -1),
      makeTextMsg("new-id", "user", "different"),
    ];
    expect(hashMessageIds(differentOlder)).not.toBe(hash1);
  });

  test("too few messages does not trigger compaction", () => {
    const PRESERVE_RECENT = 6;
    // Need at least PRESERVE_RECENT + 2 messages
    const messages = Array.from({ length: 7 }, (_, i) =>
      makeTextMsg(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "x".repeat(20000),
      ),
    );
    // Even though chars are high, message count is below threshold
    expect(messages.length).toBeLessThan(PRESERVE_RECENT + 2);
  });
});

describe("feature flags", () => {
  test("README documents feature flag env vars", () => {
    const content = readFileSync(join(import.meta.dir, "README.md"), "utf-8");
    expect(content).toContain("MORPH_EDIT");
    expect(content).toContain("MORPH_WARPGREP");
    expect(content).toContain("MORPH_COMPACT");
  });
});

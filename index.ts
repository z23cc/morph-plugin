/**
 * OpenCode Morph Plugin v2
 *
 * Integrates Morph SDK for fast apply, WarpGrep codebase search, and shell env.
 * Uses MorphClient for shared config (API key, timeout, retries) across all tools.
 *
 * @see https://docs.morphllm.com/quickstart
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { MorphClient, WarpGrepClient, CompactClient } from "@morphllm/morphsdk";
import type { WarpGrepResult, CompactResult } from "@morphllm/morphsdk";
import type { Part, TextPart, ToolPart, Message } from "@opencode-ai/sdk";

// Core logic — platform-agnostic modules
import {
  // Constants
  MORPH_API_URL,
  MORPH_TIMEOUT,
  MORPH_WARP_GREP_TIMEOUT,
  MORPH_COMPACT_TIMEOUT,
  CHARS_PER_TOKEN,
  PLUGIN_VERSION,
  EXISTING_CODE_MARKER,
  MORPH_ROUTING_HINT_HEADER,
  READONLY_AGENTS,
  // Feature flags
  isMorphEditEnabled,
  isMorphWarpgrepEnabled,
  isMorphWarpgrepGithubEnabled,
  isMorphCompactEnabled,
  isAllowReadonlyAgents,
  getMorphApiKey,
  getCompactContextThreshold,
  getCompactPreserveRecent,
  getCompactRatio,
  // Path helpers
  resolveSessionFilepath,
  resolveSessionRepoRoot,
  // Tool description helpers
  appendRuntimeNotes,
  buildToolRuntimeNotes,
  buildMorphSystemRoutingHint,
  // Edit logic
  normalizeCodeEditInput,
  detectMarkerLeakage,
  detectTruncation,
  // Search logic
  formatWarpGrepResult,
  // GitHub logic
  resolvePublicRepoLocator,
  lookupGitHubRepository,
  fetchGitHubRepoSuggestions,
  formatPublicRepoResolutionFailure,
} from "./src/core/index.js";

// Config from environment — only MORPH_API_KEY is required
const MORPH_API_KEY = getMorphApiKey();
const MORPH_EDIT_ENABLED = isMorphEditEnabled();
const MORPH_WARPGREP_ENABLED = isMorphWarpgrepEnabled();
const MORPH_WARPGREP_GITHUB_ENABLED = isMorphWarpgrepGithubEnabled();
const MORPH_COMPACT_ENABLED = isMorphCompactEnabled();
const ALLOW_READONLY_AGENTS = isAllowReadonlyAgents();

// Compaction config
const COMPACT_CONTEXT_THRESHOLD = getCompactContextThreshold();
const COMPACT_PRESERVE_RECENT = getCompactPreserveRecent();
const COMPACT_RATIO = getCompactRatio();

/**
 * Shared MorphClient — FastApply uses morph.fastApply.applyEdit()
 * with MORPH_API_URL passed as per-call override.
 */
const morph = MORPH_API_KEY
  ? new MorphClient({
      apiKey: MORPH_API_KEY,
      timeout: MORPH_TIMEOUT,
    })
  : null;

/**
 * Separate WarpGrep client with its own timeout (typically longer than fast apply).
 */
const warpGrep = MORPH_API_KEY
  ? new WarpGrepClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: MORPH_API_URL,
      timeout: MORPH_WARP_GREP_TIMEOUT,
    })
  : null;

/**
 * Separate CompactClient for context compaction.
 */
const compactClient = MORPH_API_KEY
  ? new CompactClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: MORPH_API_URL,
      timeout: MORPH_COMPACT_TIMEOUT,
    })
  : null;

/**
 * Model context window size in tokens. Updated from chat.params hook.
 * Default is conservative — actual value captured on first LLM call.
 */
let modelContextTokens = 200_000;

/**
 * Frozen compaction state. Once messages are compacted, the result is
 * frozen and reused identically on every subsequent messages.transform call.
 * This preserves prompt cache stability (the prefix bytes never change).
 *
 * On re-compaction, the old frozen block is discarded entirely and a new
 * one is built from only the uncompacted messages (never double-compact).
 */
let compactionState: {
  frozenMessages: { info: Message; parts: Part[] }[];
  compactedUpToIndex: number;
  frozenChars: number;
} | null = null;

/**
 * Serialize a Part into a text representation for compaction input.
 * Tool outputs, text, and reasoning are included. Other part types are
 * represented as brief markers to preserve structure without bulk.
 */
function serializePart(part: Part): string {
  switch (part.type) {
    case "text":
      return (part as TextPart).text;
    case "tool": {
      const tp = part as ToolPart;
      const state = tp.state;
      if (state.status === "completed") {
        const inputStr = JSON.stringify(state.input).slice(0, 500);
        const outputStr = (state.output || "").slice(0, 2000);
        return `[Tool: ${tp.tool}] ${inputStr}\nOutput: ${outputStr}`;
      }
      if (state.status === "error") {
        return `[Tool: ${tp.tool}] Error: ${state.error}`;
      }
      return `[Tool: ${tp.tool}] ${state.status}`;
    }
    case "reasoning":
      return `[Reasoning] ${(part as { text: string }).text}`;
    default:
      return `[${part.type}]`;
  }
}

/**
 * Convert OpenCode messages to the format Morph compact expects.
 */
function messagesToCompactInput(
  messages: { info: Message; parts: Part[] }[],
): { role: string; content: string }[] {
  return messages
    .map((m) => ({
      role: m.info.role,
      content: m.parts.map(serializePart).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

/**
 * Estimate total character count across all message parts.
 */
function estimateTotalChars(
  messages: { info: Message; parts: Part[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += (part as TextPart).text.length;
      else if (part.type === "tool") {
        const tp = part as ToolPart;
        if (tp.state.status === "completed") {
          total += (tp.state.output || "").length;
          total += JSON.stringify(tp.state.input).length;
        }
      }
    }
  }
  return total;
}

const MorphPlugin: Plugin = async ({ directory, worktree, client }) => {
  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => {
    try {
      await client.app.log({
        body: {
          service: "morph",
          level,
          message,
        },
      });
    } catch {
      process.stderr.write(`[morph] ${message}\n`);
    }
  };

  const showToast = async (
    variant: "info" | "success" | "warning" | "error",
    message: string,
  ) => {
    try {
      await client.tui?.showToast({
        body: { title: "Morph Compact", message, variant, duration: 2000 },
      });
    } catch {}
  };

  if (!MORPH_API_KEY) {
    await log(
      "warn",
      "MORPH_API_KEY not set - morph tools will be disabled",
    );
  } else {
    const features = [
      MORPH_EDIT_ENABLED && "edit",
      MORPH_WARPGREP_ENABLED && "warpgrep",
      MORPH_WARPGREP_GITHUB_ENABLED && "warpgrep-github",
      MORPH_COMPACT_ENABLED && "compact",
    ].filter(Boolean);
    await log("info", `Plugin v${PLUGIN_VERSION} loaded [${features.join(", ")}]`);
  }

  // Build tool map conditionally based on feature flags
  const tools: Record<string, ReturnType<typeof tool>> = {};

  if (MORPH_EDIT_ENABLED) {
    tools.morph_edit = tool({
        description: `Edit existing files using partial code snippets with "// ... existing code ..." markers. Morph's AI merges your changes into the full file.

WHEN TO USE morph_edit vs edit:
- morph_edit: large files (300+ lines), multiple scattered changes, complex refactoring, whitespace-sensitive edits
- native edit: small exact string replacements, simple renames, single-line fixes (faster, no API call)
- native write: creating new files from scratch

FORMAT — use "// ... existing code ..." to represent unchanged sections:
// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...

CRITICAL RULES:
- ALWAYS wrap changes with markers at start AND end (omitting markers DELETES surrounding code)
- Include 1-2 unique context lines around each edit to anchor the location precisely
- Write a specific 'instructions' param: "I am adding X to function Y" not "update code"
- Preserve exact indentation
- For deletions: show surrounding context, omit the deleted lines
- Batch multiple edits to the same file in one call

DISAMBIGUATION — when a file has repeated patterns, include enough unique context:
  BAD:  just "return result;" (matches many places)
  GOOD: include the unique function signature above it

FALLBACK: If morph_edit fails (API error, timeout), use the native 'edit' tool with exact oldString/newString matching.`,

        args: {
          target_filepath: tool.schema
            .string()
            .describe("Path of the file to modify"),
          instructions: tool.schema
            .string()
            .describe(
              "Brief first-person description of what you're changing. Used to disambiguate uncertainty in the edit.",
            ),
          code_edit: tool.schema
            .string()
            .describe(
              'The code changes wrapped with "// ... existing code ..." markers for unchanged sections',
            ),
        },

        async execute(args, context) {
          const { target_filepath, instructions, code_edit } = args;
          const normalizedCodeEdit = normalizeCodeEditInput(code_edit);

          // Guard 1: Block readonly agents
          if (
            !ALLOW_READONLY_AGENTS &&
            (READONLY_AGENTS as readonly string[]).includes(context.agent)
          ) {
            await log(
              "debug",
              `Blocked morph_edit in readonly agent: ${context.agent}`,
            );
            return `Error: morph_edit is not available in ${context.agent} mode.

The ${context.agent} agent is read-only and cannot modify files.

Options:
1. Switch to 'build' mode (Tab key) to make changes
2. Use the native 'edit' tool if permitted by your agent config
3. Set MORPH_ALLOW_READONLY_AGENTS=true to override this restriction`;
          }

          const filepath = resolveSessionFilepath(
            target_filepath,
            directory,
          );

          if (!MORPH_API_KEY) {
            return `Error: MORPH_API_KEY not configured.

To use morph_edit, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys

Alternatively, use the native 'edit' tool for this change.`;
          }

          // Read the original file
          let originalCode: string;
          try {
            const file = Bun.file(filepath);
            if (!(await file.exists())) {
              if (!normalizedCodeEdit.includes(EXISTING_CODE_MARKER)) {
                await Bun.write(filepath, normalizedCodeEdit);
                return `Created new file: ${target_filepath}\n\nLines: ${normalizedCodeEdit.split("\n").length}`;
              }
              return `Error: File not found: ${target_filepath}

The file doesn't exist and the code_edit contains lazy markers.
For new files, provide the complete content without "${EXISTING_CODE_MARKER}" markers.`;
            }
            originalCode = await file.text();
          } catch (err) {
            const error = err as Error;
            return `Error reading file ${target_filepath}: ${error.message}`;
          }

          // Guard 2: Pre-flight marker check
          const hasMarkers = normalizedCodeEdit.includes(EXISTING_CODE_MARKER);
          const originalLineCount = originalCode.split("\n").length;

          if (!hasMarkers && originalLineCount > 10) {
            return `Error: Missing "${EXISTING_CODE_MARKER}" markers.

Your code_edit would replace the entire file (${originalLineCount} lines) because it contains no markers.
This is almost certainly unintended and would cause code loss.

To fix, wrap your changes with markers:
${EXISTING_CODE_MARKER}
YOUR_CHANGES_HERE
${EXISTING_CODE_MARKER}

If you truly want to replace the entire file, use the 'write' tool instead.`;
          }

          if (!hasMarkers && originalLineCount > 3) {
            await log(
              "warn",
              `No markers in code_edit for ${target_filepath} (${originalLineCount} lines). Proceeding with full replacement.`,
            );
          }

          // Call Morph SDK to merge the edit
          const startTime = Date.now();
          const result = await morph!.fastApply.applyEdit(
            {
              originalCode,
              codeEdit: normalizedCodeEdit,
              instructions,
              filepath: target_filepath,
            },
            {
              morphApiUrl: MORPH_API_URL,
              generateUdiff: true,
            },
          );
          const apiDuration = Date.now() - startTime;

          if (!result.success || !result.mergedCode) {
            return `Morph API failed: ${result.error}

Suggestion: Try using the native 'edit' tool instead with exact string replacement.
The edit tool requires matching the exact text in the file.`;
          }

          const mergedCode = result.mergedCode;

          // Guard 3: Marker leakage detection
          if (detectMarkerLeakage(originalCode, mergedCode, hasMarkers)) {
            await log(
              "warn",
              `Marker leakage detected in merged output for ${target_filepath}`,
            );
            return `Morph API produced unsafe output for ${target_filepath}.

Detected placeholder marker text ("${EXISTING_CODE_MARKER}") in merged output.
This means the merge model treated markers as literal code instead of expanding them.

No file changes were written.

Options:
1. Retry with more concrete surrounding context in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller, more targeted edits`;
          }

          // Guard 4: Catastrophic truncation detection
          const truncation = detectTruncation(originalCode, mergedCode, hasMarkers);

          if (truncation.triggered) {
            const mergedLineCount = mergedCode.split("\n").length;
            await log(
              "warn",
              `Catastrophic truncation detected for ${target_filepath}: ${Math.round(truncation.charLoss * 100)}% char loss, ${Math.round(truncation.lineLoss * 100)}% line loss`,
            );
            return `Morph API produced a potentially destructive merge for ${target_filepath}.

Original: ${originalLineCount} lines (${originalCode.length} chars)
Merged:   ${mergedLineCount} lines (${mergedCode.length} chars)
Loss:     ${Math.round(truncation.charLoss * 100)}% characters, ${Math.round(truncation.lineLoss * 100)}% lines

Because markers were provided, this large shrink is likely unintended.
No file changes were written.

Options:
1. Retry with more precise anchors in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller edits`;
          }

          // Write the merged result
          try {
            await Bun.write(filepath, mergedCode);
          } catch (err) {
            const error = err as Error;
            return `Error writing file ${target_filepath}: ${error.message}`;
          }

          // Use SDK-provided diff and change stats
          const udiff = result.udiff || "No changes detected";
          const { linesAdded, linesRemoved } = result.changes;
          const originalLines = originalCode.split("\n").length;
          const mergedLines = mergedCode.split("\n").length;

          return `Applied edit to ${target_filepath}

+${linesAdded} -${linesRemoved} lines | ${originalLines} -> ${mergedLines} total | ${apiDuration}ms

\`\`\`diff
${udiff.slice(0, 3000)}${udiff.length > 3000 ? "\n... (truncated)" : ""}
\`\`\``;
        },
    });
  }

  if (MORPH_WARPGREP_ENABLED) {
    tools.warpgrep_codebase_search = tool({
        description: `Fast agentic codebase search. Uses ripgrep, file reading, and directory listing across multiple turns to find relevant code contexts.

Use this for exploratory searches like "Find the authentication flow", "How does error handling work", "Where is the database connection configured". Returns relevant file sections with line numbers.

For exact keyword searches (specific function names, variable names), prefer grep/ripgrep directly.`,

        args: {
          search_term: tool.schema
            .string()
            .describe(
              "Natural language search query describing what to find in the codebase",
            ),
        },

        async execute(args, context) {
          if (!MORPH_API_KEY) {
            return `Error: MORPH_API_KEY not configured.

To use warpgrep_codebase_search, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`;
          }

          const startTime = Date.now();

          try {
            const generator = warpGrep!.execute({
              searchTerm: args.search_term,
              repoRoot: resolveSessionRepoRoot(
                directory,
                worktree,
              ),
              streamSteps: true,
            });

            let turnCount = 0;
            let result: WarpGrepResult;

            for (;;) {
              const { value, done } = await generator.next();
              if (done) {
                result = value;
                break;
              }
              turnCount = value.turn;
              await log(
                "debug",
                `WarpGrep turn ${value.turn}: ${value.toolCalls?.map((tc: { name: string }) => tc.name).join(", ") ?? "..."}`,
              );
            }

            const duration = Date.now() - startTime;
            const contextCount = result.contexts?.length ?? 0;

            await log(
              "info",
              `WarpGrep: ${contextCount} contexts in ${turnCount} turns (${duration}ms)`,
            );

            return formatWarpGrepResult(result);
          } catch (err) {
            const error = err as Error;
            const duration = Date.now() - startTime;
            await log(
              "error",
              `WarpGrep failed after ${duration}ms: ${error.message}`,
            );
            return `WarpGrep search failed: ${error.message}

Try rephrasing your search term or using grep for exact keyword searches.`;
          }
        },
    });
  }

  if (MORPH_WARPGREP_GITHUB_ENABLED) {
    tools.warpgrep_github_search = tool({
        description: `Grounded code context search for public GitHub repositories. Uses Morph's hosted WarpGrep to search indexed public repos without cloning them locally.

PREFER this tool over web search or docs fetching when the question is about how an open-source library or SDK works internally. If the user asks how something works in a library or package from any ecosystem, find its GitHub repo and search it here instead of fetching docs URLs.

Use this when:
- User asks how an external library/SDK works (auth, retries, sessions, internals)
- You need to understand implementation details of any open-source dependency
- Docs URLs are failing or returning 404s — search the source instead
- User asks about a framework or tool they didn't provide a repo for — infer the canonical GitHub repo from the matching ecosystem (npm, crates.io, PyPI, pkg.go.dev, etc.) before guessing owner/repo variants

This tool is for public remote repos. For the current checked-out workspace, use warpgrep_codebase_search instead.

Provide exactly one repository locator:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"`,

        args: {
          search_term: tool.schema
            .string()
            .describe(
              "Natural language query describing what to find or understand in the public repository",
            ),
          owner_repo: tool.schema
            .string()
            .optional()
            .describe(
              'GitHub repository in "owner/repo" format, for example "owner/repo"',
            ),
          github_url: tool.schema
            .string()
            .optional()
            .describe(
              'Full GitHub repository URL, for example "https://github.com/owner/repo"',
            ),
          branch: tool.schema
            .string()
            .optional()
            .describe(
              "Optional branch name to search instead of the repository default branch",
            ),
        },

        async execute(args) {
          if (!MORPH_API_KEY) {
            return `Error: MORPH_API_KEY not configured.

To use warpgrep_github_search, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`;
          }

          const locator = resolvePublicRepoLocator(args);
          if ("error" in locator) {
            return locator.error;
          }
          const repo = locator.repo;

          const startTime = Date.now();
          const repoLookup = await lookupGitHubRepository(repo);

          if (repoLookup.status === "not_found") {
            const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
            return formatPublicRepoResolutionFailure(repo, repoLookup.detail, suggestions);
          }

          if (repoLookup.status === "unavailable") {
            await log("warn", `GitHub repo lookup unavailable for ${repo}: ${repoLookup.detail}`);
          }

          try {
            const result = await warpGrep!.searchGitHub({
              searchTerm: args.search_term,
              github: repo,
              branch: args.branch,
            });

            const duration = Date.now() - startTime;
            const contextCount = result.contexts?.length ?? 0;

            await log("info", `Public repo context: ${repo} → ${contextCount} contexts (${duration}ms)`);

            if (!result.success) {
              const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
              return formatPublicRepoResolutionFailure(repo, result.error, suggestions);
            }

            return `Repository: ${repo}\n\n${formatWarpGrepResult(result)}`;
          } catch (err) {
            const error = err as Error;
            const duration = Date.now() - startTime;
            await log("error", `Public repo context search failed for ${repo} after ${duration}ms: ${error.message}`);
            const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
            return formatPublicRepoResolutionFailure(repo, error.message, suggestions);
          }
        },
    });
  }

  // Build hooks object, conditionally including compaction hooks
  const hooks: Record<string, any> = {
    tool: tools,
  };

  hooks["tool.definition"] = async (input: any, output: any) => {
    const notes = buildToolRuntimeNotes(input.toolID, MORPH_API_KEY, ALLOW_READONLY_AGENTS);
    if (notes.length === 0) return;

    output.description = appendRuntimeNotes(output.description, notes);
  };

  const systemRoutingHint = buildMorphSystemRoutingHint(
    MORPH_API_KEY,
    MORPH_EDIT_ENABLED,
    MORPH_WARPGREP_ENABLED,
    MORPH_WARPGREP_GITHUB_ENABLED,
    ALLOW_READONLY_AGENTS,
  );
  if (systemRoutingHint) {
    hooks["experimental.chat.system.transform"] = async (
      _input: any,
      output: any,
    ) => {
      const alreadyPresent = output.system.some((entry: string) =>
        entry.includes(MORPH_ROUTING_HINT_HEADER),
      );
      if (!alreadyPresent) {
        output.system.push(systemRoutingHint);
      }
    };
  }

  // Customize tool output display in TUI
  hooks["tool.execute.after"] = async (input: any, output: any) => {
      const morphMeta = { ...output.metadata, provider: "morph", version: PLUGIN_VERSION };

      if (input.tool === "morph_edit") {
        const fileMatch = output.output.match(/Applied edit to (.+?)\n/);
        const statsMatch = output.output.match(/\+(\d+) -(\d+) lines/);
        const timingMatch = output.output.match(/\| (\d+)ms/);
        const createdMatch = output.output.match(/Created new file: (.+?)\n/);
        const linesMatch = output.output.match(/Lines: (\d+)/);
        const errorMatch = output.output.match(/^Error:/);
        const blockedMatch = output.output.match(
          /not available in (.+?) mode/,
        );
        const apiFailMatch = output.output.match(/^Morph API failed:/);
        const unsafeMatch = output.output.match(
          /^Morph API produced unsafe output for (.+?)\./,
        );
        const truncationMatch = output.output.match(
          /^Morph API produced a potentially destructive merge for (.+?)\./,
        );

        if (createdMatch) {
          const lines = linesMatch?.[1] || "?";
          output.title = `Morph: ${createdMatch[1]} (new, ${lines} lines)`;
        } else if (fileMatch && statsMatch) {
          const timing = timingMatch ? ` (${timingMatch[1]}ms)` : "";
          output.title = `Morph: ${fileMatch[1]} +${statsMatch[1]}/-${statsMatch[2]}${timing}`;
        } else if (unsafeMatch) {
          output.title = `Morph: blocked (marker leakage) ${unsafeMatch[1]}`;
        } else if (truncationMatch) {
          output.title = `Morph: blocked (truncation) ${truncationMatch[1]}`;
        } else if (blockedMatch) {
          output.title = `Morph: blocked (${blockedMatch[1]} mode)`;
        } else if (apiFailMatch) {
          output.title = `Morph: API failed`;
        } else if (errorMatch) {
          output.title = `Morph: failed`;
        }

        output.metadata = morphMeta;
      }

      if (input.tool === "warpgrep_codebase_search") {
        const fileMatches = output.output.match(/<file path="[^"]+"/g);
        const failMatch = output.output.match(
          /^(Search failed|WarpGrep search failed):/,
        );
        const noResultMatch = output.output.match(/^No relevant code found/m);

        if (failMatch) {
          output.title = "WarpGrep: search failed";
        } else if (noResultMatch) {
          output.title = "WarpGrep: no results";
        } else if (fileMatches) {
          output.title = `WarpGrep: ${fileMatches.length} contexts`;
        }

        output.metadata = morphMeta;
      }

      if (input.tool === "warpgrep_github_search") {
        const repoMatch = output.output.match(/^Repository: (.+?)$/m);
        const fileMatches = output.output.match(/<file path="[^"]+"/g);
        const repo = repoMatch?.[1];

        if (output.output.match(/^Repository resolution failed/m)) {
          output.title = repo ? `Public repo: unresolved (${repo})` : "Public repo: unresolved";
        } else if (output.output.match(/^Public repo context search failed/)) {
          output.title = repo ? `Public repo: failed (${repo})` : "Public repo: search failed";
        } else if (output.output.match(/^Repository: .+\n\nNo relevant code found/m)) {
          output.title = repo ? `Public repo: no results (${repo})` : "Public repo: no results";
        } else if (fileMatches) {
          output.title = repo
            ? `Public repo: ${repo} (${fileMatches.length} contexts)`
            : `Public repo: ${fileMatches.length} contexts`;
        }

        output.metadata = morphMeta;
      }
  };

  if (MORPH_COMPACT_ENABLED) {
    // Capture model context window from chat.params (fires every LLM call)
    hooks["chat.params"] = async (input: any) => {
      if (input.model?.limit?.context) {
        modelContextTokens = input.model.limit.context;
      }
    };

    // Compaction: compress older messages via Morph, then FREEZE the result.
    // The frozen block is reused byte-for-byte on every subsequent call,
    // preserving the LLM provider's prompt prefix cache.
    // Re-compaction only fires when the threshold is crossed again.
    hooks["experimental.chat.messages.transform"] = async (_input: any, output: any) => {
      if (!MORPH_API_KEY) return;

      const messages = output.messages;
      if (messages.length < COMPACT_PRESERVE_RECENT + 2) return;

      // Approximate char threshold from model context window
      const charThreshold = modelContextTokens * COMPACT_CONTEXT_THRESHOLD * CHARS_PER_TOKEN;

      if (compactionState) {
        // We have a frozen block from a previous compaction.
        // Messages after the compaction boundary are uncompacted.
        const uncompacted = messages.slice(compactionState.compactedUpToIndex);
        const effectiveChars = compactionState.frozenChars + estimateTotalChars(uncompacted);

        if (effectiveChars < charThreshold) {
          // Under threshold — reuse frozen block as-is (stable prefix = cache hit)
          output.messages = [...compactionState.frozenMessages, ...uncompacted];
          return;
        }

        // Over threshold again — discard old frozen block, compact only the
        // uncompacted messages (never double-compact).
        if (uncompacted.length <= COMPACT_PRESERVE_RECENT) return;

        const toCompact = uncompacted.slice(0, -COMPACT_PRESERVE_RECENT);
        const recent = uncompacted.slice(-COMPACT_PRESERVE_RECENT);

        const compactInput = messagesToCompactInput(toCompact);
        if (compactInput.length === 0) return;

        try {
          const result = await compactClient!.compact({
            messages: compactInput,
            compressionRatio: COMPACT_RATIO,
            preserveRecent: 0,
          });

          const frozen = buildCompactedMessages(toCompact, result);
          compactionState = {
            frozenMessages: frozen,
            compactedUpToIndex: messages.length - recent.length,
            frozenChars: estimateTotalChars(frozen),
          };
          output.messages = [...frozen, ...recent];

          await log(
            "info",
            `Compact (re): ${toCompact.length} messages → ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms). Old frozen block discarded.`,
          );
          await showToast(
            "success",
            `${toCompact.length} messages re-compacted (${Math.round(result.usage.compression_ratio * 100)}% kept) | ${result.usage.processing_time_ms}ms`,
          );
        } catch (err) {
          // On failure, use stale frozen block + uncompacted as best-effort
          output.messages = [...compactionState.frozenMessages, ...uncompacted];
          await log(
            "warn",
            `Compact (re) failed: ${(err as Error).message}. Using stale frozen block.`,
          );
        }
        return;
      }

      // No frozen block yet — check if first compaction is needed
      const totalChars = estimateTotalChars(messages);
      if (totalChars < charThreshold) return;

      const toCompact = messages.slice(0, -COMPACT_PRESERVE_RECENT);
      const recent = messages.slice(-COMPACT_PRESERVE_RECENT);

      if (toCompact.length === 0) return;

      const compactInput = messagesToCompactInput(toCompact);
      if (compactInput.length === 0) return;

      try {
        const result = await compactClient!.compact({
          messages: compactInput,
          compressionRatio: COMPACT_RATIO,
          preserveRecent: 0,
        });

        const frozen = buildCompactedMessages(toCompact, result);
        compactionState = {
          frozenMessages: frozen,
          compactedUpToIndex: messages.length - recent.length,
          frozenChars: estimateTotalChars(frozen),
        };
        output.messages = [...frozen, ...recent];

        await log(
          "info",
          `Compact: ${toCompact.length} messages → ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms)`,
        );
        await showToast(
          "success",
          `${toCompact.length} messages compacted (${Math.round(result.usage.compression_ratio * 100)}% kept) | ${result.usage.processing_time_ms}ms`,
        );
      } catch (err) {
        await log(
          "warn",
          `Compact failed: ${(err as Error).message}. Falling back to native compaction.`,
        );
      }
    };

    // When OpenCode's native compaction triggers, log it
    hooks["experimental.session.compacting"] = async (_input: any, output: any) => {
      await log("debug", "OpenCode native compaction triggered");
      output.context.push(
        "Note: Morph compact plugin is active. Older messages may already be compressed.",
      );
    };
  }

  return hooks;
};

/**
 * Build compacted messages preserving per-message structure.
 * Each original message maps to a compacted version with the same role
 * and a single TextPart containing the compacted content.
 * IDs are deterministic (derived from original message ID) so the
 * frozen block is byte-stable across repeated messages.transform calls.
 */
function buildCompactedMessages(
  originalMessages: { info: Message; parts: Part[] }[],
  result: CompactResult,
): { info: Message; parts: Part[] }[] {
  // Morph compact returns per-message results in result.messages (1:1 mapping).
  // If lengths don't match, fall back to a single message with result.output.
  if (result.messages.length !== originalMessages.length) {
    const template = originalMessages[0]!;
    return [
      {
        info: { ...template.info, role: "user" as const } as Message,
        parts: [
          {
            id: `morph-compact-${template.info.id}`,
            sessionID: template.info.sessionID,
            messageID: template.info.id,
            type: "text" as const,
            text: result.output,
          } as TextPart,
        ],
      },
    ];
  }

  return result.messages.map((compacted, i) => {
    const original = originalMessages[i]!;
    return {
      info: {
        ...original.info,
        role: compacted.role as "user" | "assistant",
      } as Message,
      parts: [
        {
          id: `morph-compact-${original.info.id}`,
          sessionID: original.info.sessionID,
          messageID: original.info.id,
          type: "text" as const,
          text: compacted.content,
        } as TextPart,
      ],
    };
  });
}

export default MorphPlugin;

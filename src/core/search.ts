/**
 * WarpGrep codebase search logic.
 *
 * Platform-agnostic — no imports from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import type { WarpGrepResult } from "@morphllm/morphsdk";

/**
 * Format WarpGrep results for tool output.
 */
export function formatWarpGrepResult(result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed: ${result.error}`;
  }

  if (!result.contexts || result.contexts.length === 0) {
    return "No relevant code found. Try rephrasing your search term.";
  }

  const parts: string[] = [];
  parts.push("Relevant context found:");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? "*"
        : ctx.lines.map(([s, e]) => `${s}-${e}`).join(",");
    parts.push(`- ${ctx.file}:${rangeStr}`);
  }

  parts.push("\nFile contents:\n");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? ""
        : ` lines="${ctx.lines.map(([s, e]) => `${s}-${e}`).join(",")}"`;
    parts.push(`<file path="${ctx.file}"${rangeStr}>`);
    parts.push(ctx.content);
    parts.push("</file>\n");
  }

  return parts.join("\n");
}

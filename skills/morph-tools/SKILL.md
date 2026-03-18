---
name: morph-tools
description: |
  Tool routing for Morph CLI — Fast Apply (10,500+ tok/s code editing),
  WarpGrep (agentic codebase search), public GitHub repo context search,
  and context compaction (25,000+ tok/s). Loaded automatically so the model
  chooses the right tool for each task.
user-invocable: false
---

# Morph CLI Tool Routing

## Prerequisites

The `morph` CLI must be installed and `MORPH_API_KEY` must be set.
If `morph --version` fails, tell the user to run:
```bash
npm i -g @duange/morph-plugin
export MORPH_API_KEY="sk-..."
```

## Commands

### morph edit --file <path>
Pipe code edits via stdin. 10,500+ tok/s fast apply with safety guards.

```bash
echo '// ... existing code ...
function hello() {
  return "hello world";
}
// ... existing code ...' | morph edit --file src/app.ts
```

**Use morph edit when:**
- Large file edits (300+ lines)
- Multiple scattered changes in one file
- Whitespace-sensitive edits
- Complex refactors inside existing files

**Do NOT use morph edit when:**
- Small exact `oldString` → `newString` replacement → use Edit tool
- Creating brand new files → use Write tool
- `MORPH_API_KEY` is not set → fall back to Edit tool

### morph search --query <text> [--dir <path>]
Fast agentic codebase search via WarpGrep. +4% SWE-Bench Pro.

```bash
morph search --query "how does auth middleware work"
morph search --query "database config" --dir ./backend
```

**Use for:** natural-language exploratory searches.
**Do NOT use for:** exact keyword/function name lookup → use Grep.

### morph github --repo <owner/repo> --query <text>
Public GitHub repo context search without cloning.

```bash
morph github --repo "vercel/next.js" --query "middleware matching"
```

**Use for:** understanding open-source library internals.
**Do NOT use for:** the current local project → use `morph search`.

### morph compact [--ratio <0.05-1.0>]
Context compression at 25,000+ tok/s. Pipe text via stdin.

```bash
cat conversation.txt | morph compact
cat context.txt | morph compact --ratio 0.2
```

**Use for:** compressing large context before sending to LLM.
**Default ratio:** 0.3 (keeps ~30% of original). Lower = more aggressive.

## Decision Table

| Task | Tool | Reason |
|------|------|--------|
| Large file (300+ lines) | `morph edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph edit` | Batch edits |
| Small exact replacement | Edit | Faster, no API call |
| New file | Write | morph edit only edits existing files |
| Codebase exploration | `morph search` | Agentic multi-turn search |
| Public repo understanding | `morph github` | Grounded context |
| Exact keyword lookup | Grep | Direct ripgrep |
| Compress large context | `morph compact` | 25,000+ tok/s compression |

## Exit Codes & Fallback

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue |
| 1 | Input/config error | Fix input, retry |
| 2 | API error | Retry once, then use native tool |
| 3 | Safety guard blocked | Use Edit tool instead |

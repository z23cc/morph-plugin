# Morph CLI Tool Selection Policy

This instruction teaches Claude Code (and other AI coding assistants that invoke
tools via Bash) when and how to use the Morph CLI. It is the CLI counterpart of
`morph-tools.md`, which targets the OpenCode plugin interface.

Copy this file into your project or global instructions so the model reliably
chooses the right tool for each task.

## Available Commands

### morph edit --file \<path\>

Pipe code edits via stdin. 10,500+ tok/s fast apply with safety guards.

```bash
echo "edited code with lazy markers" | morph edit --file src/app.ts
```

The CLI reads the edited content from stdin, sends it to the Morph Fast Apply
API, merges the result into the target file, and writes it to disk. Safety
guards block the write when markers leak into the merged output or when the
merge loses too much of the original file.

**When to use morph edit:**

| Editing task | Why morph edit wins |
|---|---|
| Large file edits (300+ lines) | Avoids fragile exact-string matching |
| Multiple scattered changes in one file | Batch edits efficiently |
| Whitespace-sensitive edits | More forgiving with formatting |
| Complex refactors inside an existing file | Better partial-file merge behavior |

**When NOT to use morph edit:**

- Small exact `oldString` -> `newString` replacement -- use the Edit tool
- Creating brand new files -- use the Write tool
- `MORPH_API_KEY` is not configured -- fall back to the Edit tool

### morph search --query \<text\> [--dir \<path\>]

Fast agentic codebase search via WarpGrep. +4% accuracy on SWE-Bench Pro.

```bash
morph search --query "how does auth middleware work"
morph search --query "where is the DB connection configured" --dir src/
```

Returns relevant file contexts with line ranges in a single call. Use it for
natural-language, exploratory searches where you do not already know the exact
function or variable name.

**When to use:**

- Natural-language exploratory searches ("how does auth work?")
- Finding where functionality is implemented across files
- Understanding code flow when you are new to a codebase

**When NOT to use:**

- Exact keyword or function name lookup -- use the Grep tool directly

### morph github --repo \<owner/repo\> --query \<text\>

Grounded context search for public GitHub repos without cloning.

```bash
morph github --repo "vercel/next.js" --query "how does middleware matching work"
morph github --repo "axios/axios" --query "retry logic implementation"
```

Returns relevant file contexts from Morph's indexed public repo search. Use it
when you need implementation-level understanding of an open-source dependency
and docs are insufficient or unavailable.

**When to use:**

- Understanding how an external library or SDK works internally
- Implementation details of open-source dependencies
- When docs URLs fail or return 404s -- search the source instead

**When NOT to use:**

- Searching the current local project -- use `morph search` instead

## First-Action Decision Table

| Task | First tool | Why |
|---|---|---|
| Large file (300+ lines) | `morph edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph edit` | Batch edits efficiently |
| Whitespace-sensitive edit | `morph edit` | Forgiving formatting |
| Small exact replacement | Edit tool | Faster, local, no API call |
| Single-line rename or fix | Edit tool | Simpler exact replacement |
| New file creation | Write tool | morph edit only edits existing files |
| Codebase search / exploration | `morph search` | Fast agentic search |
| Public GitHub repo understanding | `morph github` | Grounded context without cloning |
| Exact keyword lookup | Grep tool | Direct ripgrep, no API call |

## Fallback Policy

- If `morph edit` fails due to API error or timeout, use the native Edit tool
- If `morph edit` is blocked by a safety guard (exit code 3), use the native Edit tool
- If `morph search` fails, fall back to Grep + Read
- If `morph github` fails, fall back to web search or clone the repo

## Exit Codes

| Code | Meaning | Action |
|---|---|---|
| 0 | Success | Continue |
| 1 | Input or config error | Fix the input and retry |
| 2 | API or network error | Retry once, then fall back to native tool |
| 3 | Safety guard blocked the write | Use native Edit tool instead |

## Anti-Patterns

- Do NOT use the Edit tool first for large, scattered, or whitespace-sensitive edits
- Do NOT use `morph edit` for creating new files
- Do NOT use `morph search` for exact string or keyword lookups
- Do NOT use `morph github` for the current local project
- Do NOT retry indefinitely on exit code 3 -- switch to the native Edit tool

## Setup

Install the CLI globally:

```bash
npm i -g @morphllm/cli
```

Or run commands without installing:

```bash
npx morph edit --file src/app.ts
npx morph search --query "auth flow"
```

Set your API key:

```bash
export MORPH_API_KEY="sk-..."
```

For Claude Code, copy this file to your project's `.claude/` directory or
reference it in your global instructions at `~/.claude/CLAUDE.md` so the model
loads the routing policy on every conversation.

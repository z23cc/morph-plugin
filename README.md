# morph-plugin

Claude Code plugin + CLI for [Morph](https://morphllm.com). Four tools:

- **Fast Apply** — 10,500+ tok/s code editing with lazy markers
- **WarpGrep** — fast agentic codebase search, +4% on SWE-Bench Pro, -15% cost
- **Public Repo Context** — grounded context search for public GitHub repos without cloning
- **Compaction** — 25,000+ tok/s context compression

![WarpGrep SWE-bench Pro Benchmarks](assets/warpgrep-benchmarks.png)

---

## Setup

### 1. Get an API key

Sign up at [morphllm.com/dashboard](https://morphllm.com/dashboard/api-keys) and add it to your environment:

```bash
export MORPH_API_KEY="sk-..."
```

### 2. Install the CLI

```bash
npm i -g @duange/morph-plugin
```

### 3. Configure Claude Code

Set the API key in Claude Code settings (`~/.claude/settings.json`):

```json
{
  "env": {
    "MORPH_API_KEY": "sk-..."
  }
}
```

Add tool routing instructions so Claude Code knows when to use morph:

```bash
# Copy to your project
mkdir -p .claude/instructions
cp node_modules/@duange/morph-plugin/instructions/claude-code.md .claude/instructions/

# Or add to global CLAUDE.md
cat node_modules/@duange/morph-plugin/instructions/claude-code.md >> ~/.claude/CLAUDE.md
```

---

## CLI Commands

### morph edit --file \<path\>

10,500+ tok/s code merging. Pipe partial code snippets via stdin with `// ... existing code ...` markers.

```bash
echo '// ... existing code ...
function hello() {
  return "hello world";
}
// ... existing code ...' | morph edit --file src/app.ts
```

Safety guards block writes when markers leak into merged output or when the merge loses too much of the original file.

### morph search --query \<text\> [--dir \<path\>]

Fast agentic codebase search via WarpGrep. Sub-6s per query.

```bash
morph search --query "how does auth middleware work"
morph search --query "database config" --dir ./backend
```

### morph github --repo \<owner/repo\> --query \<text\>

Grounded context search for public GitHub repos without cloning.

```bash
morph github --repo "vercel/next.js" --query "middleware matching"
morph github --url "https://github.com/axios/axios" --query "retry logic"
```

### morph compact [--ratio \<0.05-1.0\>] [--preserve-recent \<n\>]

25,000+ tok/s context compression. Pipe text via stdin.

```bash
cat long-conversation.txt | morph compact
cat context.txt | morph compact --ratio 0.2
```

Default ratio is 0.3 (keeps ~30% of original). Lower = more aggressive compression.

---

## Tool Selection Guide

| Task | Tool | Why |
|------|------|-----|
| Large file (300+ lines) | `morph edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph edit` | Batch edits efficiently |
| Small exact replacement | `Edit` | Faster, no API call |
| New file creation | `Write` | morph edit only edits existing files |
| Codebase search / exploration | `morph search` | Fast agentic search |
| Public GitHub repo understanding | `morph github` | Grounded context without cloning |
| Exact keyword lookup | `Grep` | Direct ripgrep, no API call |
| Compress large context | `morph compact` | 25,000+ tok/s compression |

---

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue |
| 1 | Input or config error | Fix input, retry |
| 2 | API or network error | Retry once, then fallback to native tool |
| 3 | Safety guard blocked | Use native Edit tool instead |

---

## Development

```bash
bun install
bun test          # 124 tests
bun run typecheck # tsc --noEmit
bun run build     # tsc
```

## License

[MIT](LICENSE)

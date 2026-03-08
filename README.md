# opencode-morph-plugin

Three tools that make [OpenCode](https://opencode.ai) agents faster, cheaper, and more accurate.

![WarpGrep SWE-bench Pro Benchmarks](assets/warpgrep-benchmarks.png)

On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task accuracy by **6%**, reduces cost, and is net **28% faster**.

## Quick start

```bash
# 1. Set your API key (get one at morphllm.com/dashboard)
export MORPH_API_KEY="sk-..."

# 2. Add the plugin
ln -s /path/to/opencode-morph-plugin/index.ts ~/.config/opencode/plugin/morph.ts

# 3. Add the SDK dependency
cat > ~/.config/opencode/package.json << 'EOF'
{ "dependencies": { "@morphllm/morphsdk": "^0.2.134" } }
EOF

# 4. (Recommended) Add tool routing instructions
cp instructions/morph-tools.md ~/.config/opencode/instructions/
```

OpenCode runs `bun install` at startup. That's it.

Or, when published as an npm package:

```json
{ "plugin": ["opencode-morph-plugin"] }
```

---

## What's inside

### Fast Apply (`morph_edit`)

10,500+ tok/s code editing. The LLM writes partial snippets with lazy markers (`// ... existing code ...`) and Morph merges them into the full file. No exact string matching required.

```
  // ... existing code ...           function validateToken(token) {
  function validateToken(token) {      const decoded = jwt.verify(token);
    if (!token) {             ──>      if (!token) {
      throw new Error("...");            throw new Error("...");
    }                                  }
    // ... existing code ...           return decoded;
  }                                  }
  // ... existing code ...           export default validateToken;
```

Three safety guards run before every write:
- **Pre-flight marker check** blocks edits with no markers on files >10 lines (prevents accidental full-file replacement)
- **Marker leakage detection** aborts if `// ... existing code ...` appears in the merged output but wasn't in the original
- **Truncation detection** aborts if the merged output loses >60% characters and >50% lines

All guards return actionable errors: retry with tighter anchors, use native `edit`, or split into smaller edits.

### WarpGrep (`warpgrep_codebase_search`)

Fast agentic codebase search. A lightweight agent runs ripgrep, reads files, and lists directories across multiple turns to find relevant code. Returns file sections with line numbers.

**+4% accuracy on SWE-Bench Pro. -15% cost. Sub-6 seconds.**

```
  "How does auth middleware work?"

  Turn 1: ripgrep "auth" "token" "jwt"
  Turn 2: read src/middleware/auth.ts
  Turn 3: ripgrep "verifyToken"
  Turn 4: read src/utils/jwt.ts
       ↓
  5 file contexts with line ranges
```

Use for exploratory queries ("how does X work?", "where is Y handled?"). For exact keyword lookup, use `grep` directly.

### Proactive Compaction

Auto-compresses older messages before context overflow. Preempts OpenCode's built-in auto-compact (which triggers at 95% of the context window) with higher-quality compression via Morph's specialized compaction model in under 2 seconds.

```
  20 messages (140k+ chars)
       ↓ Morph Compact API (~2s)
  7 messages (compacted summary + 6 recent messages preserved)
```

How it works:
1. On each LLM call, the plugin estimates total content size
2. When above threshold (default 140k chars), older messages are compressed
3. The compacted result replaces older messages in the context window
4. Original messages stay untouched in the database
5. Results are cached by message IDs to avoid redundant API calls

---

## Tool selection guide

| Task | Tool | Why |
|------|------|-----|
| Large file (300+ lines) | `morph_edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph_edit` | Batch edits efficiently |
| Small exact replacement | `edit` | Faster, no API call |
| New file creation | `write` | morph_edit only edits existing files |
| Codebase search/exploration | `warpgrep_codebase_search` | Fast agentic search |
| Exact keyword lookup | `grep` | Direct ripgrep, no API call |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | required | Your Morph API key |
| `MORPH_EDIT` | `true` | Set `false` to disable Fast Apply |
| `MORPH_WARPGREP` | `true` | Set `false` to disable WarpGrep |
| `MORPH_COMPACT` | `true` | Set `false` to disable compaction |
| `MORPH_COMPACT_CHAR_THRESHOLD` | `140000` | Char count before compaction triggers |
| `MORPH_COMPACT_RATIO` | `0.3` | Compression ratio (0.05-1.0, lower = more aggressive) |

---

## Development

```bash
bun install
bun test          # 57 tests
bun run typecheck # tsc --noEmit
```

Built on [Morph SDK](https://www.npmjs.com/package/@morphllm/morphsdk) (`MorphClient` for Fast Apply, `WarpGrepClient` for search, `CompactClient` for compaction).

## License

[MIT](LICENSE)

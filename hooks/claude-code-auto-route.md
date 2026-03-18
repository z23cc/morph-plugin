# Auto-Route Large Edits to Morph

Claude Code supports [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
that run before or after tool calls. You can use a `PreToolUse` hook to nudge
the model toward `morph edit` whenever it is about to edit a large file with the
built-in Edit tool.

## How it works

The hook fires before every Edit tool call. It checks the target file's line
count. If the file has more than 300 lines, it injects a tip into the
conversation suggesting `morph edit` as a more reliable alternative. The edit
is still allowed to proceed -- this is a nudge, not a block.

## Installation

Add the following to your Claude Code settings file at
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "command": "bash -c 'FILE=\"$TOOL_INPUT_file_path\"; if [ -f \"$FILE\" ] && [ $(wc -l < \"$FILE\") -gt 300 ]; then echo \"{\\\"decision\\\": \\\"allow\\\", \\\"message\\\": \\\"Tip: This file has 300+ lines. Consider using morph edit for more reliable merging: echo \\\\\\\"your code\\\\\\\" | morph edit --file $FILE\\\"}\"; fi'"
      }
    ]
  }
}
```

If you already have other hooks in `settings.json`, append the object above to
the existing `PreToolUse` array.

## What each field does

| Field | Value | Purpose |
|---|---|---|
| `matcher` | `"Edit"` | Only fires on the built-in Edit tool |
| `command` | bash one-liner | Checks line count and emits a JSON tip |
| `decision` | `"allow"` | Lets the edit proceed (not a block) |
| `message` | tip string | Shown to the model as guidance |

## Customization

**Change the line threshold.** Replace `300` in the command with your preferred
cutoff. Lower values (e.g. 200) nudge more aggressively; higher values
(e.g. 500) only trigger on very large files.

**Block instead of nudge.** Change `"allow"` to `"block"` if you want to force
the model to use `morph edit` for large files. This prevents the Edit tool from
running at all when the file exceeds the threshold.

## Prerequisites

- The `morph` CLI must be installed (`npm i -g @morphllm/cli` or use `npx morph`)
- `MORPH_API_KEY` must be set in your environment
- Claude Code must be running with hooks enabled (default in recent versions)

## Verifying it works

1. Open a project with a file over 300 lines.
2. Ask Claude Code to make a change to that file.
3. Look for the tip message in the conversation: "Tip: This file has 300+ lines..."
4. The model should switch to `morph edit` for that change.

If you do not see the tip, confirm that `settings.json` is valid JSON and that
the hook is inside the `PreToolUse` array.

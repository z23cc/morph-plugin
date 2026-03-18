/**
 * CLI tests for morph commands.
 *
 * All subprocess tests invoke the compiled dist/src/cli/index.js via Node.js
 * so that no build step is required during testing. Unit tests for pure utility
 * functions import directly from source.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUnifiedDiff, colorizeDiff, countChanges } from "./src/cli/utils/diff.js";
import { normalizeCodeEditInput, detectTruncation, detectMarkerLeakage } from "./src/core/edit.js";

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

const CLI_PATH = join(import.meta.dir, "dist/src/cli/index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  args: string[],
  options?: {
    input?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  },
): CliResult {
  // Strip undefined values and merge with process.env
  const envOverrides = options?.env ?? {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  const result = spawnSync("node", [CLI_PATH, ...args], {
    input: options?.input,
    encoding: "utf-8",
    env,
    cwd: options?.cwd,
    timeout: 15000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

// ---------------------------------------------------------------------------
// 1. CLI entrypoint tests (no API key needed)
// ---------------------------------------------------------------------------

describe("CLI entrypoint", () => {
  test("--help outputs usage and exits 0", () => {
    const { stdout, exitCode } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("morph - Morph SDK CLI");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("morph edit");
    expect(stdout).toContain("morph search");
    expect(stdout).toContain("morph github");
    expect(stdout).toContain("MORPH_API_KEY");
  });

  test("-h outputs usage and exits 0", () => {
    const { stdout, exitCode } = runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("--version outputs version string and exits 0", () => {
    const { stdout, exitCode } = runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^morph \d+\.\d+\.\d+/);
  });

  test("-v outputs version string and exits 0", () => {
    const { stdout, exitCode } = runCli(["-v"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^morph \d+\.\d+\.\d+/);
  });

  test("no args shows help and exits 0", () => {
    const { stdout, exitCode } = runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("unknown command exits 1 with error message", () => {
    const { stderr, exitCode } = runCli(["foobar"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown command "foobar"');
    expect(stderr).toContain("--help");
  });

  test("unknown command does not output to stdout", () => {
    const { stdout, exitCode } = runCli(["unknowncmd"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Edit command validation tests (no API call needed)
// ---------------------------------------------------------------------------

describe("edit command validation", () => {
  test("morph edit without --file exits 1", () => {
    const { stderr, exitCode } = runCli(["edit"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--file");
  });

  test("morph edit --file without a following value exits 1", () => {
    // When --file is the last arg, fileIndex + 1 >= args.length
    const { stderr, exitCode } = runCli(["edit", "--file"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--file");
  });

  test("empty stdin exits 1", () => {
    const { stderr, exitCode } = runCli(["edit", "--file", "/tmp/any.ts"], {
      input: "",
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("stdin is empty");
  });

  test("whitespace-only stdin exits 1", () => {
    const { stderr, exitCode } = runCli(["edit", "--file", "/tmp/any.ts"], {
      input: "   \n   ",
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("stdin is empty");
  });

  test("file not found with markers exits 1", () => {
    const { stderr, exitCode } = runCli(
      ["edit", "--file", "/nonexistent/path/missing.ts"],
      {
        input: "// ... existing code ...\nconst x = 1;\n// ... existing code ...",
        env: { MORPH_API_KEY: "test-key" },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("file not found");
    expect(stderr).toContain("/nonexistent/path/missing.ts");
  });

  test("file not found without markers creates the file", async () => {
    // NOTE: The edit CLI keeps its event loop alive for up to 30s after writing
    // the file (due to readStdin's dangling timeout Promise). We therefore use
    // an async Bun.spawn approach: spawn the process, wait for the file to
    // appear, then kill the process and assert the file was written.
    const tmpDir = mkdtempSync(join(tmpdir(), "morph-cli-test-"));
    const newFile = join(tmpDir, "created.ts");

    try {
      const proc = Bun.spawn({
        cmd: ["node", CLI_PATH, "edit", "--file", newFile],
        stdin: new TextEncoder().encode("export const created = true;\n"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MORPH_API_KEY: "test-key" },
      });

      // Poll for the file to appear (max 5s)
      const deadline = Date.now() + 5000;
      while (!existsSync(newFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Terminate the hanging process (stdin timeout keeps it alive for 30s)
      proc.kill();

      expect(existsSync(newFile)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);

  test("missing MORPH_API_KEY exits 1 with helpful message", () => {
    const { stderr, exitCode } = runCli(["edit", "--file", "/tmp/any.ts"], {
      input: "some content",
      env: { MORPH_API_KEY: undefined },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("MORPH_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// 3. Search command validation tests (no API call needed)
// ---------------------------------------------------------------------------

describe("search command validation", () => {
  test("morph search without --query exits 1", () => {
    const { stderr, exitCode } = runCli(["search"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--query");
  });

  test("morph search --query without value exits 1", () => {
    // --query is the last argument, so queryIndex + 1 >= args.length
    const { stderr, exitCode } = runCli(["search", "--query"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--query");
  });

  test("morph search --query 'test' --dir without value exits 1", () => {
    // --dir is the last argument with no following value
    const { stderr, exitCode } = runCli(
      ["search", "--query", "test", "--dir"],
      {
        env: { MORPH_API_KEY: "test-key" },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dir");
    expect(stderr).toContain("requires a value");
  });

  test("missing MORPH_API_KEY exits 1 with helpful message", () => {
    const { stderr, exitCode } = runCli(
      ["search", "--query", "find something"],
      {
        env: { MORPH_API_KEY: undefined },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("MORPH_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// 4. GitHub command validation tests (no API call needed)
// ---------------------------------------------------------------------------

describe("github command validation", () => {
  test("morph github without --repo or --url exits 1", () => {
    const { stderr, exitCode } = runCli(["github"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--repo");
    expect(stderr).toContain("--url");
  });

  test("morph github --repo without value and without --query exits 1", () => {
    // --repo with no args after it => queryIndex === -1
    const { stderr, exitCode } = runCli(["github", "--repo"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--query");
  });

  test("morph github --repo and --url both provided exits 1", () => {
    const { stderr, exitCode } = runCli(
      [
        "github",
        "--repo",
        "owner/repo",
        "--url",
        "https://github.com/owner/repo",
        "--query",
        "test",
      ],
      {
        env: { MORPH_API_KEY: "test-key" },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("provide either --repo or --url, not both");
  });

  test("morph github --repo 'bad format' --query 'test' exits 1", () => {
    const { stderr, exitCode } = runCli(
      ["github", "--repo", "badformat", "--query", "test"],
      {
        env: { MORPH_API_KEY: "test-key" },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("owner/repo");
  });

  test("morph github without --query exits 1", () => {
    const { stderr, exitCode } = runCli(["github", "--repo", "owner/repo"], {
      env: { MORPH_API_KEY: "test-key" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--query");
  });

  test("missing MORPH_API_KEY exits 1 after valid repo format", () => {
    // Valid format passes resolvePublicRepoLocator, then API key check fires
    // But lookupGitHubRepository may be called first -- we just check exit 1
    const { exitCode } = runCli(
      ["github", "--repo", "owner/repo", "--query", "test"],
      {
        env: { MORPH_API_KEY: undefined },
      },
    );
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Diff utility unit tests
// ---------------------------------------------------------------------------

describe("generateUnifiedDiff", () => {
  test("identical strings return only header lines (no hunks)", () => {
    const content = "line one\nline two\nline three";
    const lines = generateUnifiedDiff(content, content, "src/foo.ts");
    // Headers are always present
    expect(lines[0]).toMatch(/^--- a\//);
    expect(lines[1]).toMatch(/^\+\+\+ b\//);
    // No hunk lines for identical content
    const hunkLines = lines.filter((l) => l.startsWith("@@"));
    expect(hunkLines).toHaveLength(0);
    const addedLines = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const removedLines = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(addedLines).toHaveLength(0);
    expect(removedLines).toHaveLength(0);
  });

  test("added lines show + prefix", () => {
    const original = "line one\nline two";
    const modified = "line one\nline two\nline three added";
    const lines = generateUnifiedDiff(original, modified, "src/foo.ts");
    const addedLines = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(addedLines.length).toBeGreaterThan(0);
    expect(addedLines.some((l) => l.includes("line three added"))).toBe(true);
  });

  test("removed lines show - prefix", () => {
    const original = "line one\nline two\nline three to remove";
    const modified = "line one\nline two";
    const lines = generateUnifiedDiff(original, modified, "src/foo.ts");
    const removedLines = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(removedLines.length).toBeGreaterThan(0);
    expect(removedLines.some((l) => l.includes("line three to remove"))).toBe(true);
  });

  test("absolute filepath in diff header is normalized (no double slash)", () => {
    const lines = generateUnifiedDiff("a\n", "b\n", "/absolute/path/file.ts");
    // displayPath strips leading slash to avoid a//absolute/path/...
    expect(lines[0]).toBe("--- a/absolute/path/file.ts");
    expect(lines[1]).toBe("+++ b/absolute/path/file.ts");
    expect(lines[0]).not.toContain("a//");
    expect(lines[1]).not.toContain("b//");
  });

  test("relative filepath in diff header has a/ and b/ prefix", () => {
    const lines = generateUnifiedDiff("x\n", "y\n", "src/relative.ts");
    expect(lines[0]).toBe("--- a/src/relative.ts");
    expect(lines[1]).toBe("+++ b/src/relative.ts");
  });

  test("returns exactly two header lines for empty strings", () => {
    const lines = generateUnifiedDiff("", "", "empty.ts");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^---/);
    expect(lines[1]).toMatch(/^\+\+\+/);
  });
});

describe("colorizeDiff", () => {
  test("returns plain text when isTTY is false", () => {
    const original = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      const lines = ["--- a/foo.ts", "+++ b/foo.ts", "+added line", "-removed line"];
      const result = colorizeDiff(lines);
      expect(result).not.toContain("\x1b[");
      expect(result).toContain("+added line");
      expect(result).toContain("-removed line");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test("returns ANSI codes when isTTY is true", () => {
    const original = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      const lines = ["+added line", "-removed line"];
      const result = colorizeDiff(lines);
      // ANSI escape sequences should be present
      expect(result).toContain("\x1b[");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test("joins lines with newline separator", () => {
    const lines = ["line one", "line two", "line three"];
    const result = colorizeDiff(lines);
    expect(result).toContain("\n");
    expect(result.split("\n")).toHaveLength(3);
  });

  test("empty array returns empty string", () => {
    const result = colorizeDiff([]);
    expect(result).toBe("");
  });
});

describe("countChanges", () => {
  test("counts additions correctly (excludes +++ header)", () => {
    const lines = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      " context line",
      "+added line one",
      "+added line two",
      "-removed line",
    ];
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(2);
    expect(deletions).toBe(1);
  });

  test("counts deletions correctly (excludes --- header)", () => {
    const lines = ["--- a/foo.ts", "+++ b/foo.ts", "-removed one", "-removed two", "-removed three"];
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(0);
    expect(deletions).toBe(3);
  });

  test("returns zero for header-only diff", () => {
    const lines = ["--- a/foo.ts", "+++ b/foo.ts"];
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(0);
    expect(deletions).toBe(0);
  });

  test("returns zero for empty array", () => {
    const { additions, deletions } = countChanges([]);
    expect(additions).toBe(0);
    expect(deletions).toBe(0);
  });

  test("ignores @@ hunk header lines", () => {
    const lines = ["@@ -1,3 +1,3 @@", "+added", "-deleted"];
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });

  test("ignores context lines (space prefix)", () => {
    const lines = [" context one", " context two", "+added", "-deleted"];
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Core function unit tests
// ---------------------------------------------------------------------------

describe("normalizeCodeEditInput", () => {
  test("strips markdown fences with language tag", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = 1;");
  });

  test("strips markdown fences without language tag", () => {
    const input = "```\nconst x = 1;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = 1;");
  });

  test("preserves content without markdown fences", () => {
    const input = "const x = 1;\nconst y = 2;";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("handles CRLF line endings within fences", () => {
    // The fence check splits on \n; content with \r in middle lines is preserved
    const input = "```typescript\r\nconst x = 1;\r\n```";
    // After trim+split on \n: ["```typescript\r", "const x = 1;\r", "```"]
    // firstLine = "```typescript\r".trimEnd() = "```typescript" => matches
    // lastLine = "```".trimEnd() = "```" => matches
    const result = normalizeCodeEditInput(input);
    expect(result).not.toContain("```typescript");
    expect(result).not.toContain("```");
  });

  test("returns input unchanged for short input (fewer than 3 lines)", () => {
    expect(normalizeCodeEditInput("hello")).toBe("hello");
    expect(normalizeCodeEditInput("line1\nline2")).toBe("line1\nline2");
  });

  test("returns empty string unchanged", () => {
    expect(normalizeCodeEditInput("")).toBe("");
  });

  test("preserves existing code markers inside fences", () => {
    const inner = "// ... existing code ...\nfunction foo() {}\n// ... existing code ...";
    const input = `\`\`\`typescript\n${inner}\n\`\`\``;
    expect(normalizeCodeEditInput(input)).toBe(inner);
  });

  test("does not strip when closing fence has language tag", () => {
    const input = "```typescript\nfoo()\n```typescript";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("trims surrounding whitespace before fence detection", () => {
    const input = "  \n```javascript\nconst y = 2;\n```\n  ";
    expect(normalizeCodeEditInput(input)).toBe("const y = 2;");
  });
});

describe("detectTruncation", () => {
  test("returns triggered=false for empty originalCode", () => {
    const result = detectTruncation("", "new content here", true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBe(0);
    expect(result.lineLoss).toBe(0);
  });

  test("returns triggered=false when hasMarkers is false regardless of loss", () => {
    const original = "x".repeat(1000) + "\n".repeat(100);
    const merged = "x".repeat(100);
    const result = detectTruncation(original, merged, false);
    expect(result.triggered).toBe(false);
  });

  test("returns triggered=true when both char and line loss exceed thresholds", () => {
    const original = "x".repeat(1000) + "\n".repeat(100);
    const merged = "x".repeat(300) + "\n".repeat(40);
    const result = detectTruncation(original, merged, true);
    expect(result.triggered).toBe(true);
    expect(result.charLoss).toBeGreaterThan(0.6);
    expect(result.lineLoss).toBeGreaterThan(0.5);
  });

  test("returns triggered=false when only char loss exceeds threshold", () => {
    // Lines stay similar, only chars removed
    const original = "x    ".repeat(200) + "\n".repeat(50);
    const merged = "x".repeat(200) + "\n".repeat(50);
    const result = detectTruncation(original, merged, true);
    expect(result.triggered).toBe(false);
    expect(result.lineLoss).toBeLessThanOrEqual(0.5);
  });

  test("returns triggered=false when only line loss exceeds threshold", () => {
    const original = Array.from({ length: 100 }, () => "ab").join("\n");
    const merged = Array.from({ length: 40 }, () => "ab".repeat(3)).join("\n");
    const result = detectTruncation(original, merged, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
  });

  test("returns correct charLoss and lineLoss metrics", () => {
    // "abcde\nfghij\nklmno" = 17 chars (5 + 1 + 5 + 1 + 5), 3 lines
    const original = "abcde\nfghij\nklmno";
    const merged = "abcde"; // 5 chars, 1 line
    const result = detectTruncation(original, merged, true);
    // charLoss = (17 - 5) / 17 ≈ 0.7059
    expect(result.charLoss).toBeCloseTo((17 - 5) / 17, 3);
    // lineLoss = (3 - 1) / 3 ≈ 0.6667
    expect(result.lineLoss).toBeCloseTo((3 - 1) / 3, 3);
    expect(result.triggered).toBe(true);
  });

  test("returns triggered=false when file grows (negative charLoss)", () => {
    const original = "short\nfile\n";
    const merged = "short\nfile\nwith\nmany\nnew\nlines\n";
    const result = detectTruncation(original, merged, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThan(0);
  });
});

describe("detectMarkerLeakage", () => {
  const MARKER = "// ... existing code ...";

  test("returns false when original already had the marker", () => {
    const original = `// Use "${MARKER}" to indicate unchanged code`;
    const merged = `${original}\n// new line`;
    // Original already contains marker => not a leak
    expect(detectMarkerLeakage(original, merged, true)).toBe(false);
  });

  test("returns true when merged output leaks marker not in original", () => {
    const original = "function foo() { return 1; }";
    const merged = `function foo() { return 1; }\n${MARKER}\nfunction bar() {}`;
    expect(detectMarkerLeakage(original, merged, true)).toBe(true);
  });

  test("returns false when hasMarkers is false", () => {
    const original = "function foo() {}";
    const merged = `function foo() {}\n${MARKER}`;
    expect(detectMarkerLeakage(original, merged, false)).toBe(false);
  });

  test("returns false when merged output has no marker leakage", () => {
    const original = "function foo() { return 1; }";
    const merged = "function foo() { return 2; }";
    expect(detectMarkerLeakage(original, merged, true)).toBe(false);
  });

  test("returns true when marker leaks at the start of merged output", () => {
    const original = "const x = 1;\nconst y = 2;";
    const merged = `${MARKER}\nconst x = 1;\nconst y = 2;`;
    expect(detectMarkerLeakage(original, merged, true)).toBe(true);
  });

  test("returns true when marker leaks at the end of merged output", () => {
    const original = "const x = 1;\nconst y = 2;";
    const merged = `const x = 1;\nconst y = 2;\n${MARKER}`;
    expect(detectMarkerLeakage(original, merged, true)).toBe(true);
  });
});

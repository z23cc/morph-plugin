/**
 * Colorized unified diff output utility.
 *
 * Produces a minimal unified diff between two strings.
 * When stdout is a TTY, additions are green and deletions are red.
 * When piped, plain text is emitted.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/**
 * Generate a unified diff between two strings.
 * Returns an array of diff lines (with +/- prefixes).
 */
export function generateUnifiedDiff(
  original: string,
  modified: string,
  filepath: string,
): string[] {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const result: string[] = [];

  // File headers — normalize absolute paths to avoid double-slash
  const displayPath = filepath.startsWith("/") ? filepath.slice(1) : filepath;
  result.push(`--- a/${displayPath}`);
  result.push(`+++ b/${displayPath}`);

  // Simple LCS-based diff
  const hunks = computeHunks(oldLines, newLines);

  for (const hunk of hunks) {
    result.push(
      `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) {
      result.push(line);
    }
  }

  return result;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Compute diff hunks between old and new line arrays using a simple
 * longest common subsequence approach with context lines.
 */
function computeHunks(
  oldLines: string[],
  newLines: string[],
  contextSize: number = 3,
): Hunk[] {
  // Build edit script using Myers-like O(ND) approach simplified
  // For practical purposes, use a straightforward approach
  const changes = computeChanges(oldLines, newLines);

  if (changes.length === 0) return [];

  // Group changes into hunks with context
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  // Track the effective position in the old file independently of oldCount,
  // so that insert changes (which don't consume old lines) don't cause
  // oldStart + oldCount to lag behind the actual old-file position.
  let oldPos = 0;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;

    if (
      currentHunk === null ||
      change.oldIndex - oldPos > contextSize * 2
    ) {
      // Start new hunk
      if (currentHunk) {
        // Add trailing context to previous hunk
        addTrailingContext(currentHunk, oldLines, contextSize);
        hunks.push(currentHunk);
      }

      // Add leading context
      const contextStart = Math.max(0, change.oldIndex - contextSize);
      currentHunk = {
        oldStart: contextStart,
        oldCount: change.oldIndex - contextStart,
        newStart: contextStart + (change.newIndex - change.oldIndex),
        newCount: change.oldIndex - contextStart,
        lines: [],
      };
      for (let j = contextStart; j < change.oldIndex; j++) {
        currentHunk.lines.push(` ${oldLines[j]}`);
      }
      oldPos = change.oldIndex;
    } else {
      // Fill gap with context lines between changes
      for (let j = oldPos; j < change.oldIndex; j++) {
        currentHunk.lines.push(` ${oldLines[j]}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
      }
      oldPos = change.oldIndex;
    }

    // Add the change itself
    if (change.type === "delete" || change.type === "replace") {
      currentHunk.lines.push(`-${oldLines[change.oldIndex]}`);
      currentHunk.oldCount++;
      oldPos = change.oldIndex + 1;
    }
    if (change.type === "insert" || change.type === "replace") {
      currentHunk.lines.push(`+${newLines[change.newIndex]}`);
      currentHunk.newCount++;
    }
  }

  if (currentHunk) {
    addTrailingContext(currentHunk, oldLines, contextSize);
    hunks.push(currentHunk);
  }

  return hunks;
}

function addTrailingContext(
  hunk: Hunk,
  oldLines: string[],
  contextSize: number,
): void {
  const end = Math.min(
    oldLines.length,
    hunk.oldStart + hunk.oldCount + contextSize,
  );
  const start = hunk.oldStart + hunk.oldCount;
  for (let i = start; i < end; i++) {
    hunk.lines.push(` ${oldLines[i]}`);
    hunk.oldCount++;
    hunk.newCount++;
  }
}

interface Change {
  type: "delete" | "insert" | "replace";
  oldIndex: number;
  newIndex: number;
}

/**
 * Compute a list of changes between old and new line arrays.
 * Uses a simple LCS approach suitable for typical source file diffs.
 */
function computeChanges(oldLines: string[], newLines: string[]): Change[] {
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, use a hash-based approach
  // Build LCS table using O(min(m,n)) space with Hirschberg-like optimization
  // For simplicity and correctness, use standard DP with bounded size
  if (m + n > 50000) {
    // Fallback: line-by-line comparison for huge files
    return simpleLineChanges(oldLines, newLines);
  }

  // Standard LCS with DP
  const lcs = computeLCS(oldLines, newLines);
  const changes: Change[] = [];

  let oi = 0;
  let ni = 0;

  for (const [lcsOld, lcsNew] of lcs) {
    // Lines before this LCS match
    while (oi < lcsOld && ni < lcsNew) {
      changes.push({ type: "replace", oldIndex: oi, newIndex: ni });
      oi++;
      ni++;
    }
    while (oi < lcsOld) {
      changes.push({ type: "delete", oldIndex: oi, newIndex: ni });
      oi++;
    }
    while (ni < lcsNew) {
      changes.push({ type: "insert", oldIndex: oi, newIndex: ni });
      ni++;
    }
    // Skip matching line
    oi++;
    ni++;
  }

  // Remaining lines after last LCS match
  while (oi < m && ni < n) {
    changes.push({ type: "replace", oldIndex: oi, newIndex: ni });
    oi++;
    ni++;
  }
  while (oi < m) {
    changes.push({ type: "delete", oldIndex: oi, newIndex: ni });
    oi++;
  }
  while (ni < n) {
    changes.push({ type: "insert", oldIndex: oi, newIndex: ni });
    ni++;
  }

  return changes;
}

/**
 * Compute LCS indices using standard DP.
 * Returns array of [oldIndex, newIndex] pairs.
 */
function computeLCS(
  oldLines: string[],
  newLines: string[],
): [number, number][] {
  const m = oldLines.length;
  const n = newLines.length;

  // Full DP table using number[][] (no Uint16Array overflow risk)
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to find actual LCS
  const result: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Simple fallback for very large files.
 */
function simpleLineChanges(oldLines: string[], newLines: string[]): Change[] {
  const changes: Change[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      changes.push({ type: "insert", oldIndex: oldLines.length, newIndex: i });
    } else if (i >= newLines.length) {
      changes.push({ type: "delete", oldIndex: i, newIndex: newLines.length });
    } else if (oldLines[i] !== newLines[i]) {
      changes.push({ type: "replace", oldIndex: i, newIndex: i });
    }
  }

  return changes;
}

/**
 * Format diff lines with ANSI colors for TTY output.
 */
export function colorizeDiff(lines: string[]): string {
  const isTTY = process.stdout.isTTY;

  return lines
    .map((line) => {
      if (!isTTY) return line;

      if (line.startsWith("+++") || line.startsWith("---")) {
        return `${CYAN}${line}${RESET}`;
      }
      if (line.startsWith("+")) {
        return `${GREEN}${line}${RESET}`;
      }
      if (line.startsWith("-")) {
        return `${RED}${line}${RESET}`;
      }
      if (line.startsWith("@@")) {
        return `${CYAN}${line}${RESET}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Count additions and deletions from diff lines.
 */
export function countChanges(lines: string[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return { additions, deletions };
}

#!/usr/bin/env -S node --no-deprecation

/**
 * morph CLI
 *
 * Wraps Morph SDK functionality (FastApply, WarpGrep) for use with
 * any AI coding tool via Bash.
 *
 * Commands:
 *   morph edit   --file <path>                      Apply code edits via stdin
 *   morph search --query <text> [--dir <path>]      Local codebase search
 *   morph github --repo <owner/repo> --query <text> GitHub repo search
 *
 * Environment:
 *   MORPH_API_KEY  Required API key for Morph services
 */

// Node.js version check -- must run before any other imports
const [major] = process.versions.node.split(".").map(Number);
if (major! < 18) {
  console.error(
    `morph requires Node.js >= 18 (found ${process.version})`,
  );
  process.exit(1);
}

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Walk up to find package.json (handles both src/cli/ and dist/cli/)
    for (const candidate of [
      resolve(__dirname, "../../package.json"),
      resolve(__dirname, "../package.json"),
      resolve(__dirname, "../../../package.json"),
    ]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name && pkg.version) return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fileURLToPath may fail in some environments
  }
  return "0.0.0";
})();

const HELP_TEXT = `morph - Morph SDK CLI for AI coding tools

Usage:
  morph edit   --file <path>                         Apply code edit from stdin
  morph search --query <text> [--dir <path>]         Local codebase search
  morph github --repo <owner/repo> --query <text>    GitHub repo search
  morph github --url <github-url> --query <text>     GitHub repo search (URL)

Options:
  --help, -h       Show this help message
  --version, -v    Show version

Environment:
  MORPH_API_KEY    Required. Get yours at https://morphllm.com/dashboard/api-keys

Examples:
  echo "add error handling" | morph edit --file src/app.ts
  morph search --query "authentication flow"
  morph search --query "database config" --dir ./backend
  morph github --repo facebook/react --query "useState implementation"
  morph github --url https://github.com/facebook/react --query "hooks"
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const command = args[0];

  // Handle top-level flags (only when they're the first arg or no command given)
  if (args.length === 0 || command === "--help" || command === "-h") {
    console.log(HELP_TEXT.trim());
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(`morph ${CLI_VERSION}`);
    process.exit(0);
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case "edit": {
      const { runEdit } = await import("./commands/edit.js");
      await runEdit(commandArgs);
      break;
    }
    case "search": {
      const { runSearch } = await import("./commands/search.js");
      await runSearch(commandArgs);
      break;
    }
    case "github": {
      const { runGithub } = await import("./commands/github.js");
      await runGithub(commandArgs);
      break;
    }
    default:
      console.error(`Error: unknown command "${command}"`);
      console.error('Run "morph --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message || err}`);
  process.exit(1);
});

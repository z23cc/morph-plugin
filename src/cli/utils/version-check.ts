/**
 * Node.js version check utility.
 *
 * This must be called at the very top of the CLI entrypoint,
 * before any other imports that might use modern APIs.
 */
export function checkNodeVersion(): void {
  const [major] = process.versions.node.split(".").map(Number);
  if (major! < 18) {
    console.error(
      `morph requires Node.js >= 18 (found ${process.version})`,
    );
    process.exit(1);
  }
}

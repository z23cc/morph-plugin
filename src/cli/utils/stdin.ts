/**
 * Shared stdin reading utility with timeout support.
 */

/**
 * Read all of stdin as a UTF-8 string, with a timeout to prevent indefinite hangs.
 * The timer is unref'd so it doesn't keep the process alive after stdin closes.
 */
export async function readStdin(timeoutMs = 30000): Promise<string> {
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdinDone = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stdin read timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  });
  await Promise.race([stdinDone, timeout]);
  if (timer) clearTimeout(timer);
  return Buffer.concat(chunks).toString("utf-8");
}

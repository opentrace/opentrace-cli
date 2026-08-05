/**
 * Is this a real interactive terminal? Prompts are only safe when both streams
 * are a TTY — in CI, a pipe, or a headless run, @inquirer/prompts would block
 * forever waiting for input that never comes, so those runs must fall back to
 * the non-interactive defaults instead.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

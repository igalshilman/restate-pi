/** Timestamped one-liners, so interleavings are visible in the terminal. */
export function log(scope: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} [${scope}] ${message}`);
}

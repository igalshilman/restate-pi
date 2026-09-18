/** Timestamped demo output, shared by the model and fake side effects. */
export function log(who: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} [${who}] ${message}`);
}

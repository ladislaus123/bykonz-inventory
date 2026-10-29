/** Minimal timestamped logger with a scope prefix. */
export function log(scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  if (extra === undefined) console.log(`${ts} [${scope}] ${msg}`);
  else console.log(`${ts} [${scope}] ${msg}`, extra);
}

export function logErr(scope: string, msg: string, err?: unknown): void {
  const ts = new Date().toISOString();
  console.error(`${ts} [${scope}] ${msg}`, err ?? '');
}

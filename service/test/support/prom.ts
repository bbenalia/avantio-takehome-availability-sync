// Value of one sample in Prometheus text, e.g. sample(text, 'portal_requests_total', { method: 'PUT', outcome: '503' }).
// Returns undefined when the series is not there.
export function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const have: Record<string, string> = {};
    for (const kv of (m[3] ?? '').matchAll(/(\w+)="([^"]*)"/g)) have[kv[1]] = kv[2];
    const keys = Object.keys(labels);
    if (keys.length !== Object.keys(have).length) continue;
    if (keys.every(k => have[k] === labels[k])) return Number(m[4]);
  }
  return undefined;
}

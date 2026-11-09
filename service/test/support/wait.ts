export async function waitFor<T>(check: () => Promise<T | false | undefined | null> | T | false | undefined | null,
  timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

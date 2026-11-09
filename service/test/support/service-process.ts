import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './wait.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type RunningService = { port: number; child: ChildProcess; base: string; exited: Promise<number | null> };

// Starts the real service (src/main.ts) as a separate process, like `npm start` does.
export async function startService(port: number, env: Record<string, string>): Promise<RunningService> {
  const child = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
    cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ...env }, stdio: 'ignore',
  });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { return (await fetch(`${base}/metrics`)).ok; } catch { return false; }
  }, 15_000, 'service to answer');
  return { port, child, base, exited };
}

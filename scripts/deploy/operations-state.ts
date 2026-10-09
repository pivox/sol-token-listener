import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ControlState = 'RUNNING' | 'ENTRY_STOP' | 'HARD_STOP';

/** `controlState` of `sol ops status` (one JSON line, see `statusJson` in executor-operations). */
export function controlStateOf(output: string): ControlState {
  const value: unknown = JSON.parse(output);
  const state = typeof value === 'object' && value !== null
    ? (value as { readonly controlState?: unknown }).controlState
    : undefined;
  if (state !== 'RUNNING' && state !== 'ENTRY_STOP' && state !== 'HARD_STOP') {
    throw new TypeError('operations status has no control state');
  }
  return state;
}

/** True when `sol ops envelope show` lists an ACTIVE envelope still inside its window. */
export function hasActiveEnvelope(output: string, nowMs: number): boolean {
  const value: unknown = JSON.parse(output);
  const envelopes = typeof value === 'object' && value !== null
    ? (value as { readonly envelopes?: unknown }).envelopes
    : undefined;
  if (!Array.isArray(envelopes)) throw new TypeError('envelope show has no envelope list');
  return envelopes.some((envelope: unknown) => {
    if (typeof envelope !== 'object' || envelope === null) return false;
    const { state, validUntilMs } = envelope as {
      readonly state?: unknown;
      readonly validUntilMs?: unknown;
    };
    return state === 'ACTIVE' && typeof validUntilMs === 'number' && validUntilMs > nowMs;
  });
}

/**
 * `control-state` prints the state; `active-envelope` exits 0 when one is active, 1 otherwise.
 * 64: usage. 65 (EX_DATAERR): the operations output is unreadable.
 */
export function runOperationsStateCli(
  argv: readonly string[],
  input: string,
  io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
  nowMs: number,
): number {
  const [command, ...rest] = argv;
  if ((command !== 'control-state' && command !== 'active-envelope') || rest.length > 0) {
    io.stderr('usage: operations-state control-state|active-envelope < command output\n');
    return 64;
  }
  try {
    if (command === 'control-state') {
      io.stdout(`${controlStateOf(input)}\n`);
      return 0;
    }
    return hasActiveEnvelope(input, nowMs) ? 0 : 1;
  } catch {
    io.stderr(`operations-state: unreadable ${command === 'control-state' ? 'status' : 'envelope'} output\n`);
    return 65;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runOperationsStateCli(process.argv.slice(2), readFileSync(0, 'utf8'), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  }, Date.now());
}

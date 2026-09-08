import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { ListenerIngestionProgram } from '../ports/listener-ingestion-program.js';

const LAUNCHPAD_PROGRAM = Object.freeze({
  key: 'launchpad',
  family: 'pumpfun',
  id: PUMP_PROGRAM_ID,
} satisfies ListenerIngestionProgram);

const MARKET_PROGRAM = Object.freeze({
  key: 'market',
  family: 'pumpswap',
  id: PUMPSWAP_PROGRAM_ID,
} satisfies ListenerIngestionProgram);

export const LAUNCHPAD_ONLY_INGESTION_PROGRAMS: readonly ListenerIngestionProgram[] =
  Object.freeze([LAUNCHPAD_PROGRAM]);

export const ALL_INGESTION_PROGRAMS: readonly ListenerIngestionProgram[] =
  Object.freeze([LAUNCHPAD_PROGRAM, MARKET_PROGRAM]);

export function listenerIngestionPrograms(
  scope: unknown,
): readonly ListenerIngestionProgram[] {
  if (scope === 'launchpad-only') return LAUNCHPAD_ONLY_INGESTION_PROGRAMS;
  if (scope === 'launchpad-and-market') return ALL_INGESTION_PROGRAMS;
  throw new TypeError('Listener ingestion scope is invalid.');
}

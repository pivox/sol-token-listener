import type { ApiSseEvent } from './api-schemas.js';

type QueryKey = readonly string[];

export const queryKeys = Object.freeze({
  launches: Object.freeze({ all: ['launches'] as const }),
  launch: (mint: string): QueryKey => ['launches', mint],
  events: (mint: string): QueryKey => ['launches', mint, 'events'],
  risk: (mint: string): QueryKey => ['launches', mint, 'risk'],
  paperPositions: Object.freeze({ all: ['paper-positions'] as const }),
  health: ['health'] as const,
  liveOverview: ['live', 'overview'] as const,
});

const PAPER_EVENTS = new Set<ApiSseEvent['type']>([
  'PaperStrategySessionUpdated', 'PaperExternalBuyCounted',
  'PaperPositionOpened', 'PaperPositionUpdated', 'PaperPositionClosed',
]);

export function invalidationKeysForEvent(event: ApiSseEvent): readonly QueryKey[] {
  const keys: QueryKey[] = [
    queryKeys.launches.all,
    queryKeys.launch(event.mint),
    queryKeys.events(event.mint),
  ];
  if (event.type === 'QualificationUpdated') keys.push(queryKeys.risk(event.mint));
  if (PAPER_EVENTS.has(event.type)) keys.push(queryKeys.paperPositions.all);
  return keys;
}

import type { SessionEngine } from '../strategy/session-engine.js';

export interface DashboardActionResult {
  readonly ok: false;
  readonly code: 'READ_ONLY';
  readonly message: string;
}

export class DashboardActionService {
  constructor(engine: SessionEngine, enabled: boolean) {
    void engine;
    void enabled;
  }

  execute(action: string, sessionId: string | null): DashboardActionResult {
    void action;
    void sessionId;
    return {
      ok: false,
      code: 'READ_ONLY',
      message: 'The Pump.fun V1 diagnostic dashboard is read-only.',
    };
  }
}

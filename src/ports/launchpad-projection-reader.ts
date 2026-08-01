import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';

export interface LaunchpadProjectionReader {
  listTrackedMints(): Promise<ReadonlySet<string>>;
  listActiveEventsBySignature(
    signature: string,
  ): Promise<readonly LaunchpadObservationEventV1[]>;
}

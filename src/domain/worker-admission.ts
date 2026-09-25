export const PUMPFUN_WORKER_ADMISSION_POLICY_SCHEMA_VERSION =
  'pumpfun-worker-admission-policy.v1' as const;
export const MIN_PUMPFUN_TRACKING_WINDOW_SECONDS = 1;
export const DEFAULT_PUMPFUN_TRACKING_WINDOW_SECONDS = 45;
export const MAX_PUMPFUN_TRACKING_WINDOW_SECONDS = 3_600;

export interface PumpFunWorkerAdmissionPolicyV1 {
  readonly schemaVersion: typeof PUMPFUN_WORKER_ADMISSION_POLICY_SCHEMA_VERSION;
  readonly enabled: false;
  readonly trackingWindowSeconds: number;
}

export interface PumpFunWorkerAdmissionPolicyInput {
  readonly enabled: unknown;
  readonly trackingWindowSeconds: unknown;
}

export function createPumpFunWorkerAdmissionPolicy(
  input: PumpFunWorkerAdmissionPolicyInput,
): PumpFunWorkerAdmissionPolicyV1 {
  if (input.enabled !== false) {
    throw new TypeError('The inactive Pump.fun worker admission policy requires enabled=false.');
  }
  if (
    typeof input.trackingWindowSeconds !== 'number'
    || !Number.isSafeInteger(input.trackingWindowSeconds)
    || input.trackingWindowSeconds < MIN_PUMPFUN_TRACKING_WINDOW_SECONDS
    || input.trackingWindowSeconds > MAX_PUMPFUN_TRACKING_WINDOW_SECONDS
  ) {
    throw new TypeError('The Pump.fun worker admission tracking window is invalid.');
  }
  return Object.freeze({
    schemaVersion: PUMPFUN_WORKER_ADMISSION_POLICY_SCHEMA_VERSION,
    enabled: false,
    trackingWindowSeconds: input.trackingWindowSeconds,
  });
}

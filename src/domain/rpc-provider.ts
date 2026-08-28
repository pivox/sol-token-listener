export const RPC_PROVIDER_IDS = Object.freeze([
  'primary',
  'fallback-1',
  'fallback-2',
  'fallback-3',
] as const);

export type RpcProviderId = (typeof RPC_PROVIDER_IDS)[number];

export function isRpcProviderId(value: unknown): value is RpcProviderId {
  return typeof value === 'string'
    && (RPC_PROVIDER_IDS as readonly string[]).includes(value);
}

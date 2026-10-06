export interface RpcBalanceReaderOptions {
  readonly rpcUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The operator API's only RPC call: the confirmed lamport balance of one public key. */
export function createRpcBalanceReader(
  options: RpcBalanceReaderOptions,
): (wallet: string) => Promise<bigint> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return async (wallet: string): Promise<bigint> => {
    const response = await fetchFn(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getBalance',
        params: [wallet, { commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('getBalance request failed');
    const body: unknown = await response.json();
    const value = balanceValue(body);
    if (value === null) throw new Error('getBalance response is invalid');
    return BigInt(value);
  };
}

function balanceValue(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('result' in body)) return null;
  const result = body.result;
  if (typeof result !== 'object' || result === null || !('value' in result)) return null;
  const value = result.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface ProxyRequest {
  readonly method?: string | undefined;
}

interface ProxyResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(): void;
}

export function rejectNonReadOnlyApiMethod(
  request: ProxyRequest,
  response: ProxyResponse,
): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return false;
  }
  response.statusCode = 405;
  response.setHeader('Allow', 'GET, HEAD, OPTIONS');
  response.end();
  return true;
}

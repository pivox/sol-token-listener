export class ApiContractError extends Error {
  public readonly issues: readonly string[];

  public constructor(
    public readonly route: string,
    issues: readonly string[],
  ) {
    super('La réponse de l’API ne respecte pas le contrat public v1.');
    this.name = 'ApiContractError';
    this.issues = Object.freeze(issues.slice(0, 8));
  }
}

export class ApiNetworkError extends Error {
  public readonly retryable = true;

  public constructor(cause?: unknown) {
    super('L’API est momentanément injoignable.', cause === undefined ? undefined : { cause });
    this.name = 'ApiNetworkError';
  }
}

export class ApiHttpError extends Error {
  public readonly retryable: boolean;

  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

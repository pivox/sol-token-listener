import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryKey,
  UndefinedInitialDataInfiniteOptions,
  UndefinedInitialDataOptions,
} from '@tanstack/react-query';
import type { ApiClient, ApiPage, PageInput } from './api-client.js';
import type {
  ApiHealth,
  ApiHolders,
  ApiLaunchDetail,
  ApiLaunchSummary,
  ApiPaperPosition,
  ApiQualification,
  ApiSocial,
  ApiTimelineEntry,
} from './api-schemas.js';
import { ApiHttpError, ApiNetworkError } from './api-errors.js';
import { queryKeys } from './query-keys.js';

const DEFAULT_PAGE_SIZE = 50;

type InfiniteOptions<T, K extends QueryKey> = UndefinedInitialDataInfiniteOptions<
  ApiPage<T>,
  Error,
  InfiniteData<ApiPage<T>, string | null>,
  K,
  string | null
>;
type StandardOptions<T, K extends QueryKey> = UndefinedInitialDataOptions<T, Error, T, K>;

function retry(failureCount: number, error: Error): boolean {
  return failureCount < 2 && (
    error instanceof ApiNetworkError
    || (error instanceof ApiHttpError && error.retryable)
  );
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}

function pageInput(cursor: string | null, signal: AbortSignal, limit: number): PageInput {
  return cursor === null ? { limit, signal } : { limit, cursor, signal };
}

const retryOptions = { retry, retryDelay } as const;

export function launchesInfiniteQuery(
  client: ApiClient,
  limit = DEFAULT_PAGE_SIZE,
): InfiniteOptions<ApiLaunchSummary, typeof queryKeys.launches.all> {
  return infiniteQueryOptions({
    queryKey: queryKeys.launches.all,
    queryFn: async ({ pageParam, signal }) => await client.listLaunches(pageInput(pageParam, signal, limit)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...retryOptions,
  });
}

export function launchQuery(
  client: ApiClient,
  mint: string,
): StandardOptions<ApiLaunchDetail, ReturnType<typeof queryKeys.launch>> {
  return queryOptions({
    queryKey: queryKeys.launch(mint),
    queryFn: async ({ signal }) => await client.getLaunch(mint, { signal }),
    ...retryOptions,
  });
}

export function timelineInfiniteQuery(
  client: ApiClient,
  mint: string,
  limit = DEFAULT_PAGE_SIZE,
): InfiniteOptions<ApiTimelineEntry, ReturnType<typeof queryKeys.events>> {
  return infiniteQueryOptions({
    queryKey: queryKeys.events(mint),
    queryFn: async ({ pageParam, signal }) => await client.listLaunchEvents(mint, pageInput(pageParam, signal, limit)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...retryOptions,
  });
}

export function riskQuery(
  client: ApiClient,
  mint: string,
): StandardOptions<ApiQualification | null, ReturnType<typeof queryKeys.risk>> {
  return queryOptions({
    queryKey: queryKeys.risk(mint),
    queryFn: async ({ signal }) => await client.getLaunchRisk(mint, { signal }),
    ...retryOptions,
  });
}

export function socialQuery(
  client: ApiClient,
  mint: string,
): StandardOptions<ApiSocial, ReturnType<typeof queryKeys.social>> {
  return queryOptions({
    queryKey: queryKeys.social(mint),
    queryFn: async ({ signal }) => await client.getLaunchSocial(mint, { signal }),
    ...retryOptions,
  });
}

export function holdersQuery(
  client: ApiClient,
  mint: string,
): StandardOptions<ApiHolders, ReturnType<typeof queryKeys.holders>> {
  return queryOptions({
    queryKey: queryKeys.holders(mint),
    queryFn: async ({ signal }) => await client.getLaunchHolders(mint, { signal }),
    ...retryOptions,
  });
}

export function paperPositionsInfiniteQuery(
  client: ApiClient,
  limit = DEFAULT_PAGE_SIZE,
): InfiniteOptions<ApiPaperPosition, typeof queryKeys.paperPositions.all> {
  return infiniteQueryOptions({
    queryKey: queryKeys.paperPositions.all,
    queryFn: async ({ pageParam, signal }) => await client.listPaperPositions(pageInput(pageParam, signal, limit)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...retryOptions,
  });
}

export function healthQuery(client: ApiClient): StandardOptions<ApiHealth, typeof queryKeys.health> {
  return queryOptions({
    queryKey: queryKeys.health,
    queryFn: async ({ signal }) => await client.getHealth({ signal }),
    refetchInterval: 10_000,
    ...retryOptions,
  });
}

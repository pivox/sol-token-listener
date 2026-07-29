import type {
  ApiHealth,
  ApiHolders,
  ApiLaunchDetail,
  ApiLaunchSummary,
  ApiPage,
  ApiPaperPosition,
  ApiQualification,
  ApiSocial,
  ApiTimelineEntry,
} from '../api/contracts.js';
import type { LaunchPagePosition, PaperPositionPagePosition, TimelinePagePosition } from '../api/cursor.js';

export const MAX_API_PAGE_LIMIT = 200;

export interface PageRequest<T> {
  readonly limit: number;
  readonly after: T | null;
}

export interface ApiProjectionRepository {
  listLaunches(request: PageRequest<LaunchPagePosition>): Promise<ApiPage<ApiLaunchSummary>>;
  getLaunch(mint: string): Promise<ApiLaunchDetail | null>;
  listLaunchEvents(mint: string, request: PageRequest<TimelinePagePosition>): Promise<ApiPage<ApiTimelineEntry>>;
  getLaunchRisk(mint: string): Promise<ApiQualification | null>;
  getLaunchSocial(mint: string): Promise<ApiSocial | null>;
  getLaunchHolders(mint: string): Promise<ApiHolders | null>;
  listPaperPositions(
    request: PageRequest<PaperPositionPagePosition>,
  ): Promise<ApiPage<ApiPaperPosition>>;
  getHealth(): Promise<ApiHealth>;
}

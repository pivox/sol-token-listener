import type { QualificationReport } from '../domain/qualification.js';

export interface QualificationReportAuthority {
  readonly isAuthorized: (report: unknown) => report is QualificationReport;
}

import type { QualificationReport } from '../domain/qualification.js';

export interface QualificationReportSubject {
  readonly mint: string;
  readonly triggerEventId: string;
}

export interface QualificationReportAuthority {
  readonly isAuthorized: (
    report: unknown,
    subject: QualificationReportSubject,
  ) => report is QualificationReport;
}

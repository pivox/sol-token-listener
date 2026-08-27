export interface CatchUpSource {
  list(programId: string, before: string | undefined, limit: number): Promise<unknown>;
}

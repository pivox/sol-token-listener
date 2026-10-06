import { z } from 'zod';
import { successEnvelope } from './api-schemas.js';

const unsignedIntegerSchema = z.string().regex(/^\d+$/u);
const signedIntegerSchema = z.string().regex(/^-?\d+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const publicKeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
const signatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,128}$/u);

const openPositionSchema = z.object({
  positionId: z.string().min(1),
  mint: publicKeySchema,
  state: z.enum(['OPEN', 'EXIT_PENDING', 'UNKNOWN']),
  openedAt: timestampSchema,
  exitDeadlineAt: timestampSchema,
  remainingRaw: unsignedIntegerSchema,
  costLamports: unsignedIntegerSchema,
  spotValueLamports: unsignedIntegerSchema.nullable(),
  unrealizedLamports: signedIntegerSchema.nullable(),
}).loose();

const closedPositionSchema = z.object({
  positionId: z.string().min(1),
  mint: publicKeySchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema,
  entrySignature: signatureSchema,
  exitSignature: signatureSchema,
  realizedLamports: signedIntegerSchema,
}).loose();

const liveOverviewSchema = z.object({
  availability: z.enum(['AVAILABLE', 'NOT_AVAILABLE']),
  wallet: publicKeySchema.nullable(),
  balance: z.object({
    lamports: unsignedIntegerSchema,
    observedAt: timestampSchema,
  }).loose().nullable(),
  open: z.array(openPositionSchema),
  history: z.array(closedPositionSchema),
  totals: z.object({
    realizedLamports: signedIntegerSchema,
    unrealizedLamports: signedIntegerSchema,
    openCount: z.number().int().nonnegative(),
    positionsWithoutPnl: z.number().int().nonnegative(),
  }).loose(),
}).loose();

export const operatorLiveOverviewEnvelopeSchema = successEnvelope(liveOverviewSchema);

export type OperatorLiveOverview = z.infer<typeof liveOverviewSchema>;
export type OperatorOpenPosition = z.infer<typeof openPositionSchema>;
export type OperatorClosedPosition = z.infer<typeof closedPositionSchema>;

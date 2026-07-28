import type {
  NormalizedInstruction,
  NormalizedTransaction,
} from '../../solana/rpc/types.js';
import { PumpSwapDecodingError } from './errors.js';
import { decodePumpSwapCpiEvent } from './event-decoder.js';
import { decodePumpSwapInstruction } from './instruction-decoder.js';
import type {
  DecodedPumpSwapCpiEvent,
  DecodedPumpSwapInstruction,
  DecodedPumpSwapPoolCreation,
  DecodedPumpSwapTrade,
  DecodedPumpSwapTransaction,
  PumpSwapIdlValue,
} from './types.js';

type ActionDecoder = (
  instruction: NormalizedInstruction,
) => DecodedPumpSwapInstruction | null;
type EventDecoder = (
  instruction: NormalizedInstruction,
) => DecodedPumpSwapCpiEvent | null;

export function decodePumpSwapTransaction(
  transaction: NormalizedTransaction,
  decodeAction: ActionDecoder = decodePumpSwapInstruction,
  decodeEvent: EventDecoder = decodePumpSwapCpiEvent,
): DecodedPumpSwapTransaction {
  if (transaction.error !== null) return empty();
  const actions = transaction.instructions
    .map(decodeAction)
    .filter((value): value is DecodedPumpSwapInstruction => value !== null);
  const events = transaction.instructions
    .map((instruction, index) => ({ index, event: decodeEvent(instruction) }))
    .filter((value): value is {
      readonly index: number;
      readonly event: DecodedPumpSwapCpiEvent;
    } => value.event !== null);
  const consumed = new Set<number>();
  const poolCreations: DecodedPumpSwapPoolCreation[] = [];
  const trades: DecodedPumpSwapTrade[] = [];

  for (const action of actions) {
    requireStack(action.instruction, transaction);
    const candidates = events.filter(({ index, event }) =>
      !consumed.has(index)
      && event.kind === action.family
      && insideScope(
        action.instruction,
        event.instruction,
        transaction.instructions,
      ));
    if (candidates.length === 0) {
      throw error('PUMPSWAP_EVENT_MISSING', transaction, action.name);
    }
    if (candidates.length > 1) {
      throw error('PUMPSWAP_EVENT_AMBIGUOUS', transaction, action.name);
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw error('PUMPSWAP_EVENT_MISSING', transaction, action.name);
    }
    consumed.add(candidate.index);
    if (isPoolAction(action) && candidate.event.kind === 'CREATE_POOL') {
      poolCreations.push(projectPool(action, candidate.event, transaction));
    } else if (
      isTradeAction(action)
      && (candidate.event.kind === 'BUY' || candidate.event.kind === 'SELL')
    ) {
      trades.push(projectTrade(action, candidate.event, transaction));
    } else {
      throw error('PUMPSWAP_EVENT_MISMATCH', transaction, action.name);
    }
  }
  if (events.some(({ index }) => !consumed.has(index))) {
    throw error('PUMPSWAP_EVENT_ORPHANED', transaction, 'event');
  }
  return Object.freeze({
    poolCreations: Object.freeze(poolCreations),
    trades: Object.freeze(trades),
  });
}

function projectPool(
  action: DecodedPumpSwapInstruction & { readonly family: 'CREATE_POOL' },
  event: DecodedPumpSwapCpiEvent & { readonly kind: 'CREATE_POOL' },
  transaction: NormalizedTransaction,
): DecodedPumpSwapPoolCreation {
  equal(account(action, 'pool'), text(event.fields, 'pool'), transaction);
  equal(account(action, 'creator'), text(event.fields, 'creator'), transaction);
  equal(account(action, 'base_mint'), text(event.fields, 'base_mint'), transaction);
  equal(account(action, 'quote_mint'), text(event.fields, 'quote_mint'), transaction);
  equal(bigint(action.args, 'index'), bigint(event.fields, 'index'), transaction);
  return Object.freeze({
    action,
    event,
    pool: account(action, 'pool'),
    index: bigint(event.fields, 'index'),
    creator: account(action, 'creator'),
    baseMint: account(action, 'base_mint'),
    quoteMint: account(action, 'quote_mint'),
  });
}

function projectTrade(
  action: DecodedPumpSwapInstruction & { readonly family: 'BUY' | 'SELL' },
  event: DecodedPumpSwapCpiEvent & { readonly kind: 'BUY' | 'SELL' },
  transaction: NormalizedTransaction,
): DecodedPumpSwapTrade {
  equal(action.family, event.kind, transaction);
  equal(account(action, 'pool'), text(event.fields, 'pool'), transaction);
  equal(account(action, 'user'), text(event.fields, 'user'), transaction);
  if (action.family === 'BUY') {
    equal(action.name, text(event.fields, 'ix_name'), transaction);
  }
  return Object.freeze({
    action,
    event,
    kind: action.family,
    pool: account(action, 'pool'),
    trader: account(action, 'user'),
    baseMint: account(action, 'base_mint'),
    quoteMint: account(action, 'quote_mint'),
    baseAmountRaw: bigint(
      event.fields,
      action.family === 'BUY' ? 'base_amount_out' : 'base_amount_in',
    ),
    quoteAmountRaw: bigint(
      event.fields,
      action.family === 'BUY'
        ? 'user_quote_amount_in'
        : 'user_quote_amount_out',
    ),
  });
}

function insideScope(
  parent: NormalizedInstruction,
  child: NormalizedInstruction,
  instructions: readonly NormalizedInstruction[],
): boolean {
  if (
    parent.stackHeight === null
    || child.stackHeight === null
    || child.innerInstructionIndex === null
    || child.instructionIndex !== parent.instructionIndex
    || child.stackHeight !== parent.stackHeight + 1
  ) return false;
  if (parent.innerInstructionIndex === null) return true;
  const parentInnerIndex = parent.innerInstructionIndex;
  const parentStackHeight = parent.stackHeight;
  if (child.innerInstructionIndex <= parentInnerIndex) return false;
  const boundary = instructions.find((candidate) =>
    candidate.instructionIndex === parent.instructionIndex
    && candidate.innerInstructionIndex !== null
    && candidate.innerInstructionIndex > parentInnerIndex
    && candidate.stackHeight !== null
    && candidate.stackHeight <= parentStackHeight);
  return boundary === undefined
    || child.innerInstructionIndex < requireInner(boundary);
}

function requireStack(
  instruction: NormalizedInstruction,
  transaction: NormalizedTransaction,
): void {
  if (instruction.stackHeight === null) {
    throw error('PUMPSWAP_STACK_HEIGHT_REQUIRED', transaction, 'stackHeight');
  }
}

function account(action: DecodedPumpSwapInstruction, name: string): string {
  const value = action.accounts[name];
  if (value === undefined) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_ACCOUNT_MISSING',
      `Compte PumpSwap absent: ${name}.`,
    );
  }
  return value;
}

function text(fields: Readonly<Record<string, PumpSwapIdlValue>>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string') throw schema(name);
  return value;
}

function bigint(
  fields: Readonly<Record<string, PumpSwapIdlValue>>,
  name: string,
): bigint {
  const value = fields[name];
  if (typeof value !== 'bigint') throw schema(name);
  return value;
}

function equal(
  left: string | bigint,
  right: string | bigint,
  transaction: NormalizedTransaction,
): void {
  if (left !== right) {
    throw error('PUMPSWAP_EVENT_MISMATCH', transaction, 'proof');
  }
}

function schema(name: string): PumpSwapDecodingError {
  return new PumpSwapDecodingError(
    'PUMPSWAP_SCHEMA_UNSUPPORTED',
    `Champ PumpSwap invalide: ${name}.`,
  );
}

function requireInner(instruction: NormalizedInstruction): number {
  if (instruction.innerInstructionIndex === null) throw schema('inner index');
  return instruction.innerInstructionIndex;
}

function error(
  code: ConstructorParameters<typeof PumpSwapDecodingError>[0],
  transaction: NormalizedTransaction,
  detail: string,
): PumpSwapDecodingError {
  return new PumpSwapDecodingError(
    code,
    `Preuve PumpSwap invalide (${detail}) dans ${transaction.signature}.`,
    transaction.signature,
  );
}

function empty(): DecodedPumpSwapTransaction {
  return Object.freeze({
    poolCreations: Object.freeze([]),
    trades: Object.freeze([]),
  });
}

function isPoolAction(
  action: DecodedPumpSwapInstruction,
): action is DecodedPumpSwapPoolCreation['action'] {
  return action.family === 'CREATE_POOL';
}

function isTradeAction(
  action: DecodedPumpSwapInstruction,
): action is DecodedPumpSwapTrade['action'] {
  return action.family === 'BUY' || action.family === 'SELL';
}

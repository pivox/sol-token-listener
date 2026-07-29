import type { TokenProgramKind } from '../../domain/types.js';
import type {
  NormalizedInstruction,
  NormalizedTransaction,
} from '../../solana/rpc/types.js';
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from './constants.js';
import { PumpDecodingError } from './errors.js';
import { decodePumpCpiEvent } from './event-decoder.js';
import { decodePumpInstruction } from './instruction-decoder.js';
import {
  normalizePumpQuoteMint,
  resolvePumpQuoteAsset,
} from './quote-asset.js';
import type {
  DecodedPumpCpiEvent,
  DecodedPumpCreation,
  DecodedPumpInstruction,
  DecodedPumpMigration,
  DecodedPumpTrade,
  DecodedPumpTransaction,
  PumpIdlValue,
} from './types.js';

interface IndexedEvent {
  readonly index: number;
  readonly decoded: DecodedPumpCpiEvent;
}

const BUY_IX_NAMES = new Set([
  'buy',
  'buy_v2',
  'buy_exact_sol_in',
  'buy_exact_quote_in',
  'buy_exact_quote_in_v2',
]);
const SELL_IX_NAMES = new Set(['sell', 'sell_v2']);

export function decodePumpTransaction(
  transaction: NormalizedTransaction,
): DecodedPumpTransaction {
  if (transaction.error !== null) return emptyResult(transaction);
  if (transaction.transactionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_TRANSACTION_INDEX_REQUIRED',
      true,
      `Transaction ${transaction.signature} sans index canonique.`,
      transaction.signature,
    );
  }

  const actions: DecodedPumpInstruction[] = [];
  const events: IndexedEvent[] = [];
  transaction.instructions.forEach((instruction, index) => {
    const action = decodePumpInstruction(instruction);
    if (action !== null) actions.push(action);
    const event = decodePumpCpiEvent(instruction);
    if (event !== null) events.push({ index, decoded: event });
  });
  validateStackHeights(actions, events, transaction);

  const consumed = new Set<number>();
  const creations: DecodedPumpCreation[] = [];
  const trades: DecodedPumpTrade[] = [];
  const migrations: DecodedPumpMigration[] = [];
  for (const action of actions) {
    if (isMigrationAction(action)) {
      migrations.push(validateMigration(action, transaction));
      continue;
    }
    const expectedKind = action.family === 'CREATE' ? 'CREATE' : 'TRADE';
    const candidates = events.filter((candidate) =>
      candidate.decoded.kind === expectedKind
      && !consumed.has(candidate.index)
      && isEventInsideActionScope(
        action.instruction,
        candidate.decoded.instruction,
        transaction.instructions,
      ));
    const paired = requireOnlyEvent(candidates, action, transaction);
    consumed.add(paired.index);
    if (isCreateAction(action) && paired.decoded.kind === 'CREATE') {
      creations.push(validateCreation(
        action,
        paired.decoded,
        transaction,
      ));
    } else if (isTradeAction(action) && paired.decoded.kind === 'TRADE') {
      trades.push(validateTrade(action, paired.decoded, transaction));
    } else {
      throw mismatch(transaction, 'Famille action/événement contradictoire.');
    }
  }

  const orphan = events.find((event) => !consumed.has(event.index));
  if (orphan !== undefined) {
    throw new PumpDecodingError(
      'PUMP_EVENT_ORPHANED',
      true,
      `Événement Pump orphelin à ${cursorKey(orphan.decoded.instruction)}.`,
      transaction.signature,
    );
  }
  return Object.freeze({
    transaction,
    creations: Object.freeze(creations),
    trades: Object.freeze(trades),
    migrations: Object.freeze(migrations),
  });
}

function emptyResult(
  transaction: NormalizedTransaction,
): DecodedPumpTransaction {
  return Object.freeze({
    transaction,
    creations: Object.freeze([]),
    trades: Object.freeze([]),
    migrations: Object.freeze([]),
  });
}

function validateMigration(
  action: DecodedPumpInstruction & { readonly family: 'MIGRATE' },
  transaction: NormalizedTransaction,
): DecodedPumpMigration {
  const isV2 = action.name === 'migrate_v2';
  const rawQuoteMint = isV2 ? account(action, 'quote_mint') : WSOL_MINT;
  const baseProgramAddress = isV2
    ? account(action, 'base_token_program')
    : account(action, 'token_program');
  const baseTokenProgram = requireSupportedProgram(
    baseProgramAddress,
    transaction,
  );
  const quoteAsset = resolvePumpQuoteAsset(rawQuoteMint, transaction);
  if (isV2) {
    requireEqual(
      quoteAsset.tokenProgram,
      requireSupportedProgram(
        account(action, 'quote_token_program'),
        transaction,
      ),
      transaction,
      'quote_token_program',
    );
  }
  return Object.freeze({
    action,
    instruction: isV2 ? 'MIGRATE_V2' : 'MIGRATE',
    mint: account(action, isV2 ? 'base_mint' : 'mint'),
    bondingCurve: account(action, 'bonding_curve'),
    announcedPool: account(action, 'pool'),
    baseTokenProgram,
    quoteAsset,
  });
}

function validateStackHeights(
  actions: readonly DecodedPumpInstruction[],
  events: readonly IndexedEvent[],
  transaction: NormalizedTransaction,
): void {
  for (const action of actions) {
    const instruction = action.instruction;
    if (instruction.stackHeight === null) {
      throw stackRequired(transaction, instruction);
    }
    const minimum = instruction.innerInstructionIndex === null ? 1 : 2;
    if (instruction.stackHeight < minimum) {
      throw new PumpDecodingError(
        'PUMP_STACK_HEIGHT_INVALID',
        true,
        `Stack height Pump invalide à ${cursorKey(instruction)}.`,
        transaction.signature,
      );
    }
  }
  for (const event of events) {
    if (event.decoded.instruction.stackHeight === null) {
      throw stackRequired(transaction, event.decoded.instruction);
    }
  }
}

function stackRequired(
  transaction: NormalizedTransaction,
  instruction: NormalizedInstruction,
): PumpDecodingError {
  return new PumpDecodingError(
    'PUMP_STACK_HEIGHT_REQUIRED',
    true,
    `Stack height Pump absent à ${cursorKey(instruction)}.`,
    transaction.signature,
  );
}

function isEventInsideActionScope(
  action: NormalizedInstruction,
  event: NormalizedInstruction,
  instructions: readonly NormalizedInstruction[],
): boolean {
  if (
    event.instructionIndex !== action.instructionIndex
    || event.innerInstructionIndex === null
    || action.stackHeight === null
    || event.stackHeight !== action.stackHeight + 1
  ) {
    return false;
  }
  if (action.innerInstructionIndex === null) return true;
  const actionInnerIndex = action.innerInstructionIndex;
  const actionStackHeight = action.stackHeight;
  if (event.innerInstructionIndex <= actionInnerIndex) return false;

  const boundary = instructions.find((candidate) =>
    candidate.instructionIndex === action.instructionIndex
    && candidate.innerInstructionIndex !== null
    && candidate.innerInstructionIndex > actionInnerIndex
    && candidate.stackHeight !== null
    && candidate.stackHeight <= actionStackHeight);
  return boundary === undefined
    || event.innerInstructionIndex < requireInnerIndex(boundary);
}

function requireInnerIndex(instruction: NormalizedInstruction): number {
  if (instruction.innerInstructionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_STACK_HEIGHT_INVALID',
      true,
      'Borne CPI Pump sans index interne.',
    );
  }
  return instruction.innerInstructionIndex;
}

function requireOnlyEvent(
  candidates: readonly IndexedEvent[],
  action: DecodedPumpInstruction,
  transaction: NormalizedTransaction,
): IndexedEvent {
  if (candidates.length === 0) {
    throw new PumpDecodingError(
      'PUMP_EVENT_MISSING',
      true,
      `Événement Pump absent pour ${action.name} à ${
        cursorKey(action.instruction)
      }.`,
      transaction.signature,
    );
  }
  if (candidates.length > 1) {
    const cursors = new Set(candidates.map((candidate) =>
      cursorKey(candidate.decoded.instruction)));
    const code = cursors.size < candidates.length
      ? 'PUMP_EVENT_DUPLICATE'
      : 'PUMP_EVENT_AMBIGUOUS';
    throw new PumpDecodingError(
      code,
      true,
      `Plusieurs événements Pump pour ${action.name}.`,
      transaction.signature,
    );
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new PumpDecodingError(
      'PUMP_EVENT_MISSING',
      true,
      `Événement Pump absent pour ${action.name}.`,
      transaction.signature,
    );
  }
  return candidate;
}

function validateCreation(
  action: DecodedPumpCreation['action'],
  eventCpi: DecodedPumpCreation['eventCpi'],
  transaction: NormalizedTransaction,
): DecodedPumpCreation {
  const event = eventCpi.event;
  requireEqual(event.mint, account(action, 'mint'), transaction, 'mint');
  requireEqual(event.name, stringArg(action, 'name'), transaction, 'name');
  requireEqual(event.symbol, stringArg(action, 'symbol'), transaction, 'symbol');
  requireEqual(event.uri, stringArg(action, 'uri'), transaction, 'uri');
  requireEqual(event.user, account(action, 'user'), transaction, 'user');
  requireEqual(
    event.creator,
    stringArg(action, 'creator'),
    transaction,
    'creator',
  );
  requireEqual(
    event.tokenProgram,
    account(action, 'token_program'),
    transaction,
    'token_program',
  );
  requireSupportedProgram(event.tokenProgram, transaction);

  if (action.name === 'create_v2') {
    requireEqual(
      event.isMayhemMode,
      booleanArg(action, 'is_mayhem_mode'),
      transaction,
      'is_mayhem_mode',
    );
    requireEqual(
      event.isCashbackEnabled,
      optionBooleanArg(action, 'is_cashback_enabled'),
      transaction,
      'is_cashback_enabled',
    );
  }

  const rawQuoteMint = action.accounts.quote_mint ?? WSOL_MINT;
  requireEqual(
    normalizePumpQuoteMint(event.quoteMint),
    normalizePumpQuoteMint(rawQuoteMint),
    transaction,
    'quote_mint',
  );
  const quoteAsset = resolvePumpQuoteAsset(rawQuoteMint, transaction);
  const quoteProgram = action.accounts.quote_token_program;
  if (quoteProgram !== undefined) {
    requireEqual(
      quoteAsset.tokenProgram,
      requireSupportedProgram(quoteProgram, transaction),
      transaction,
      'quote_token_program',
    );
  }
  return Object.freeze({ action, event, eventCpi, quoteAsset });
}

function validateTrade(
  action: DecodedPumpTrade['action'],
  eventCpi: DecodedPumpTrade['eventCpi'],
  transaction: NormalizedTransaction,
): DecodedPumpTrade {
  const event = eventCpi.event;
  const shouldBuy = action.family === 'BUY';
  requireEqual(event.isBuy, shouldBuy, transaction, 'trade_side');
  requireTradeIxSemantic(event.ixName, shouldBuy, transaction);
  requireEqual(
    event.mint,
    account(action, action.accounts.base_mint === undefined
      ? 'mint'
      : 'base_mint'),
    transaction,
    'mint',
  );
  requireEqual(event.user, account(action, 'user'), transaction, 'user');

  const rawQuoteMint = action.accounts.quote_mint ?? WSOL_MINT;
  requireEqual(
    normalizePumpQuoteMint(event.quoteMint),
    normalizePumpQuoteMint(rawQuoteMint),
    transaction,
    'quote_mint',
  );
  const baseProgram = action.accounts.base_token_program
    ?? action.accounts.token_program;
  if (baseProgram !== undefined) {
    requireSupportedProgram(baseProgram, transaction);
  }
  const quoteAsset = resolvePumpQuoteAsset(rawQuoteMint, transaction);
  const quoteProgram = action.accounts.quote_token_program;
  if (quoteProgram !== undefined) {
    requireEqual(
      quoteAsset.tokenProgram,
      requireSupportedProgram(quoteProgram, transaction),
      transaction,
      'quote_token_program',
    );
  }
  return Object.freeze({ action, event, eventCpi, quoteAsset });
}

function requireTradeIxSemantic(
  ixName: string,
  shouldBuy: boolean,
  transaction: NormalizedTransaction,
): void {
  const valid = shouldBuy
    ? BUY_IX_NAMES.has(ixName)
    : SELL_IX_NAMES.has(ixName);
  if (!valid) throw mismatch(transaction, 'Sens ix_name contradictoire.');
}

function account(action: DecodedPumpInstruction, name: string): string {
  const value = action.accounts[name];
  if (value === undefined) {
    throw new PumpDecodingError(
      'PUMP_ACCOUNT_MISSING',
      true,
      `Compte ${name} absent de ${action.name}.`,
    );
  }
  return value;
}

function stringArg(action: DecodedPumpInstruction, name: string): string {
  const value = action.args[name];
  if (typeof value !== 'string') throw schemaMismatch(action, name);
  return value;
}

function booleanArg(action: DecodedPumpInstruction, name: string): boolean {
  const value = action.args[name];
  if (typeof value !== 'boolean') throw schemaMismatch(action, name);
  return value;
}

function optionBooleanArg(
  action: DecodedPumpInstruction,
  name: string,
): boolean {
  const value = action.args[name];
  if (!isIdlArray(value) || typeof value[0] !== 'boolean') {
    throw schemaMismatch(action, name);
  }
  return value[0];
}

function isIdlArray(
  value: PumpIdlValue | undefined,
): value is readonly PumpIdlValue[] {
  return Array.isArray(value);
}

function schemaMismatch(
  action: DecodedPumpInstruction,
  name: string,
): PumpDecodingError {
  return new PumpDecodingError(
    'PUMP_SCHEMA_UNSUPPORTED',
    false,
    `Argument ${name} invalide dans ${action.name}.`,
  );
}

function requireSupportedProgram(
  program: string,
  transaction: NormalizedTransaction,
): TokenProgramKind {
  if (program === SPL_TOKEN_PROGRAM_ID) return 'SPL_TOKEN';
  if (program === TOKEN_2022_PROGRAM_ADDRESS) return 'TOKEN_2022';
  throw new PumpDecodingError(
    'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
    false,
    `Programme token Pump non pris en charge: ${program}.`,
    transaction.signature,
  );
}

function requireEqual(
  actual: string | boolean,
  expected: string | boolean,
  transaction: NormalizedTransaction,
  field: string,
): void {
  if (actual !== expected) {
    throw mismatch(transaction, `Preuves Pump contradictoires: ${field}.`);
  }
}

function mismatch(
  transaction: NormalizedTransaction,
  message: string,
): PumpDecodingError {
  return new PumpDecodingError(
    'PUMP_EVENT_MISMATCH',
    false,
    message,
    transaction.signature,
  );
}

function isCreateAction(
  action: DecodedPumpInstruction,
): action is DecodedPumpCreation['action'] {
  return action.family === 'CREATE';
}

function isTradeAction(
  action: DecodedPumpInstruction,
): action is DecodedPumpTrade['action'] {
  return action.family === 'BUY' || action.family === 'SELL';
}

function isMigrationAction(
  action: DecodedPumpInstruction,
): action is DecodedPumpMigration['action'] {
  return action.family === 'MIGRATE';
}

function cursorKey(instruction: NormalizedInstruction): string {
  return `${instruction.instructionIndex}:${
    instruction.innerInstructionIndex ?? 'outer'
  }:${instruction.stackHeight ?? 'unknown'}`;
}

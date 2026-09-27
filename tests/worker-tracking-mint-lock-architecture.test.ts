import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const producers = Object.freeze([
  'src/storage/launchpad-event.repository.ts',
  'src/storage/paper-decision.repository.ts',
  'src/storage/paper-trading.repository.ts',
  'src/storage/execution-intent.repository.ts',
  'src/storage/execution-live.repository.ts',
  'src/storage/execution-dry-run.repository.ts',
  'src/storage/execution-intent-expiration.ts',
  'src/storage/execution-operations.repository.ts',
  'src/storage/execution-risk.repository.ts',
  'src/storage/execution-simulation.repository.ts',
]);

void test('all bounded-tracking proof producers use the one shared mint-lock protocol', async () => {
  const helper = await readFile('src/storage/worker-tracking-mint-lock.ts', 'utf8');
  assert.match(helper,
    /hashtextextended\('transaction-inbox-mint:' \|\| \$1,\s*0\)/u);
  assert.match(helper, /export async function lockWorkerTrackingMints/u);
  assert.match(helper, /\.sort\(/u);
  assert.match(helper, /new Set/u);

  for (const file of producers) {
    const source = await readFile(file, 'utf8');
    assert.match(source,
      /import\s*\{[^}]*(?:\blockWorkerTrackingMints\b|\bworkerTrackingMintLockCte\b)[^}]*\}\s*from '\.\/worker-tracking-mint-lock\.js';/u,
      `${file} must import the canonical helper`);
    assert.match(source, /(?:lockWorkerTrackingMints|workerTrackingMintLockCte)\(/u,
      `${file} must acquire the shared mint lock before proof mutation`);
    const firstLock = source.search(/(?:await lockWorkerTrackingMints|workerTrackingMintLockCte)\(/u);
    const firstProofMutation = source.search(
      /(?:INSERT INTO|UPDATE)\s+(?:token_launches|trading_candidates|paper_strategy_sessions|paper_positions|execution_intents|execution_live_positions)\b/u,
    );
    assert.ok(firstLock >= 0 && (firstProofMutation < 0 || firstLock < firstProofMutation),
      `${file} must place its shared mint lock before its first authority-proof mutation`);
    assert.doesNotMatch(source,
      /hashtextextended\('transaction-inbox-mint:' \|\|/u,
      `${file} must not duplicate the namespace`);
  }
});

void test('the producer inventory covers every storage mutation of authority proof tables',
  async () => {
    const files = (await readdir('src/storage'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => `src/storage/${file}`);
    const discovered: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/(?:INSERT INTO|UPDATE)\s+(?:trading_candidates|paper_strategy_sessions|paper_positions|execution_intents|execution_live_positions)\b/u.test(source)) {
        discovered.push(file);
      }
    }
    assert.deepEqual(discovered.sort(), producers.filter((file) =>
      file !== 'src/storage/launchpad-event.repository.ts').sort());
  });

void test('the inbox uses the shared helper and has no private duplicate mint lock', async () => {
  const source = await readFile('src/storage/transaction-inbox.repository.ts', 'utf8');
  assert.match(source,
    /import\s*\{[^}]*\blockWorkerTrackingMints\b[^}]*\}\s*from '\.\/worker-tracking-mint-lock\.js';/u);
  assert.doesNotMatch(source, /function lockTrackedMint/u);
  assert.doesNotMatch(source,
    /hashtextextended\('transaction-inbox-mint:' \|\|/u);
});

void test('claim and recovery paths acquire or bind the exact mint before proof-row locks',
  async () => {
    const intents = await readFile('src/storage/execution-intent.repository.ts', 'utf8');
    assert.match(intents,
      /worker_tracking_preview AS MATERIALIZED[\s\S]*?worker_tracking_mint_lock AS MATERIALIZED[\s\S]*?candidate AS MATERIALIZED[\s\S]*?FOR UPDATE[\s\S]*?UPDATE execution_intents/u);
    assert.match(intents,
      /exactPreflightIntentLockSql[\s\S]*?worker_tracking_preview AS MATERIALIZED[\s\S]*?worker_tracking_mint_lock AS MATERIALIZED[\s\S]*?FOR UPDATE OF preparation,pair,intent/u);
    assert.match(intents,
      /selectLiveBuyClaimCandidate\(client, options\)[\s\S]*?lockWorkerTrackingMints\(client, \[candidate\.mint\]\)[\s\S]*?lockLiveSellPresenceInTransaction\(client\)[\s\S]*?claimFromClient\(client, candidate\.id\)/u);

    const expiration = await readFile('src/storage/execution-intent-expiration.ts', 'utf8');
    assert.match(expiration,
      /SELECT intent\.id,intent\.mint[\s\S]*?lockWorkerTrackingMints[\s\S]*?FOR UPDATE OF intent SKIP LOCKED[\s\S]*?UPDATE execution_intents/u);

    const paper = await readFile('src/storage/paper-decision.repository.ts', 'utf8');
    assert.match(paper,
      /SELECT DISTINCT session\.mint[\s\S]*?lockWorkerTrackingMints[\s\S]*?PAPER_DECISION_CLAIM_SCHEDULER_LOCK_SQL[\s\S]*?paperDecisionClaimSql/u);

    const live = await readFile('src/storage/execution-live.repository.ts', 'utf8');
    assert.match(live,
      /SELECT lock\.lock_id,lock\.intent_id,intent\.mint[\s\S]*?lockWorkerTrackingMints[\s\S]*?recoverStrandedPreSignatureLock\(client, generationId, snapshot\)/u);
    assert.match(live,
      /UNNEST\(\$2::TEXT\[\],\$3::TEXT\[\]\)[\s\S]*?FOR UPDATE OF lock,intent/u);
  });

void test('market observation serializes indirect candidate-proof orphaning before its private locks', async () => {
  const source = await readFile('src/storage/market-observation.repository.ts', 'utf8');
  assert.match(source,
    /import\s*\{[^}]*\blockWorkerTrackingMints\b[^}]*\}\s*from '\.\/worker-tracking-mint-lock\.js';/u);
  assert.match(source,
    /await lockWorkerTrackingMints\(client,[\s\S]*?\);[\s\S]*?await this\.lockTransactions\(client, batch\.rawEvents\);[\s\S]*?await this\.lockPools\(client, batch\);/u);
  assert.match(source,
    /batch\.matches\.map\(\(match\) => match\.migrationEvent\.mint\)[\s\S]*?batch\.trades\.map\(\(trade\) => trade\.mint\)/u);
  assert.doesNotMatch(source,
    /(?:INSERT INTO|UPDATE)\s+(?:trading_candidates|paper_strategy_sessions|paper_positions|execution_intents|execution_live_positions)\b/u);
  assert.match(source,
    /UPDATE domain_events SET confirmation_status='orphaned'/u);
});

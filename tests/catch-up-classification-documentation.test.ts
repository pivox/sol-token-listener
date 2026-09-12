import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const architectureUrl = new URL('../docs/architecture/pumpfun-v1.md', import.meta.url);
const overviewUrl = new URL('../docs/system-overview.html', import.meta.url);

void test('documents the inactive durable catch-up classification contract in both operator views', async () => {
  const documents = await Promise.all([architectureUrl, overviewUrl]
    .map(async (url) => readFile(url, 'utf8')));
  for (const document of documents) {
    assert.match(document, /048_transaction_inbox_catch_up_classification\.sql/u);
    assert.match(document, /signatures_classified/u);
    assert.match(document, /ACTIONABLE[\s\S]*DEFERRED[\s\S]*IGNORED[\s\S]*QUARANTINED/u);
    assert.match(document, /PUMP_ACTION_SUPPORTED/u);
    assert.match(document, /PROVIDER_SIGNATURE_MISSING/u);
    assert.match(document, /multi-mint/iu);
    assert.match(document, /catch_up_action_key/u);
    assert.match(document, /32\s*(?:octets|bytes)/iu);
    assert.match(document, /mint[\s\S]*signature[\s\S]*(?:row|ligne)/iu);
    assert.match(document, /confirmed[\s\S]*finalized/iu);
    assert.match(document, /inacti(?:f|ve)/iu);
    assert.match(document, /4\s*(?:h|heures)/iu);
  }
});

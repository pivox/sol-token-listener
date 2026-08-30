import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PromotedProviderSelector,
  PromotedProviderUnavailableError,
} from '../src/application/promoted-provider-selector.js';
import type { FinalityProviderPass } from '../src/ports/finality-provider-pass.js';

void test('captures the promoted provider pass for each open and leaves prior passes pinned', () => {
  const primary = pass('primary');
  const fallback = pass('fallback-1');
  const selector = new PromotedProviderSelector([primary, fallback]);

  assert.equal(selector.activeProviderId(), null);
  assert.throws(() => selector.openPass(), unavailable);

  selector.promote('primary');
  const captured = selector.openPass();
  assert.equal(captured, primary);
  assert.equal(captured.providerId, 'primary');

  selector.promote('fallback-1');
  assert.equal(captured, primary);
  assert.equal(selector.activeProviderId(), 'fallback-1');
  assert.equal(selector.openPass(), fallback);
});

void test('publishes an immutable monotone selection epoch for every promotion and effective clear', () => {
  const selector = new PromotedProviderSelector([pass('primary'), pass('fallback-1')]);

  const initial = selector.selection();
  assert.deepEqual(initial, { providerId: null, revision: 0n });
  assert.ok(Object.isFrozen(initial));

  selector.promote('primary');
  const first = selector.selection();
  assert.deepEqual(first, { providerId: 'primary', revision: 1n });

  selector.promote('primary');
  assert.deepEqual(selector.selection(), { providerId: 'primary', revision: 2n });
  assert.deepEqual(first, { providerId: 'primary', revision: 1n });

  selector.clear('fallback-1');
  assert.deepEqual(selector.selection(), { providerId: 'primary', revision: 2n });

  selector.clear('primary');
  assert.deepEqual(selector.selection(), { providerId: null, revision: 3n });
});

void test('clears only the currently promoted provider', () => {
  const primary = pass('primary');
  const fallback = pass('fallback-1');
  const selector = new PromotedProviderSelector([primary, fallback]);

  selector.promote('primary');
  selector.clear('fallback-1');
  assert.equal(selector.activeProviderId(), 'primary');

  selector.clear('primary');
  assert.equal(selector.activeProviderId(), null);
  assert.throws(() => selector.openPass(), unavailable);
});

void test('keeps promoted provider state private from runtime property injection', () => {
  const primary = pass('primary');
  const fallback = pass('fallback-1');
  const selector = new PromotedProviderSelector([primary, fallback]);
  const hostile = 'https://secret.invalid/rpc?token=hostile';

  selector.promote('primary');
  const storedPasses = Reflect.get(selector, 'passes');
  if (storedPasses instanceof Map) storedPasses.set('primary', fallback);
  Reflect.set(selector, 'activeProvider', 'fallback-1');
  Reflect.set(selector, 'activeProvider', hostile);
  Reflect.set(selector, 'passes', new Map([['primary', fallback]]));
  Reflect.set(selector, 'revision', 9_223_372_036_854_775_807n);

  assert.equal(selector.activeProviderId(), 'primary');
  assert.deepEqual(selector.selection(), { providerId: 'primary', revision: 1n });
  assert.equal(selector.openPass(), primary);
  assert.doesNotMatch(String(selector.activeProviderId()), /secret|hostile|invalid\/rpc/u);
});

void test('rejects empty, duplicate, unsupported, and malformed provider-pinned passes without exposing hostile values', () => {
  const primary = pass('primary');
  const duplicate = pass('primary');
  const hostile = 'https://secret.invalid/rpc?token=hostile';
  const unsupported = pass(hostile as 'primary');
  const malformed = Object.freeze({ providerId: 'fallback-1' }) as FinalityProviderPass;

  for (const passes of [
    [],
    [primary, duplicate],
    [unsupported],
    [malformed],
  ]) {
    assert.throws(
      () => new PromotedProviderSelector(passes),
      (error: unknown) => invalidPasses(error, hostile),
    );
  }
});

void test('rejects mutable and proxied passes before retaining a provider-pinned identity', () => {
  const mutable = {
    providerId: 'primary' as const,
    async getHistoryStatuses() { return Object.freeze([]); },
    async getFinalizedSlot() { return 0n; },
    async getFinalizedBlockSignatures() { return Object.freeze([]); },
  } satisfies FinalityProviderPass;
  const proxied = new Proxy(pass('fallback-1'), {});

  for (const passes of [[mutable], [proxied]]) {
    assert.throws(
      () => new PromotedProviderSelector(passes),
      (error: unknown) => invalidPasses(error, 'proxy-secret'),
    );
  }
});

void test('rejects promotion of an unsupported provider without exposing its value', () => {
  const selector = new PromotedProviderSelector([pass('primary')]);
  const hostile = 'https://secret.invalid/rpc?token=hostile';

  assert.throws(
    () => { selector.promote(hostile as 'primary'); },
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Promoted RPC provider is invalid.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.doesNotMatch(String(error), /secret|hostile|invalid\/rpc/u);
      return true;
    },
  );
});

function pass(providerId: 'primary' | 'fallback-1'): FinalityProviderPass {
  return Object.freeze({
    providerId,
    async getHistoryStatuses() { return Object.freeze([]); },
    async getFinalizedSlot() { return 0n; },
    async getFinalizedBlockSignatures() { return Object.freeze([]); },
  });
}

function unavailable(error: unknown): boolean {
  assert.ok(error instanceof PromotedProviderUnavailableError);
  assert.equal(error.name, 'PromotedProviderUnavailableError');
  assert.equal(error.message, 'Promoted RPC provider is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.ok(Object.isFrozen(error));
  return true;
}

function invalidPasses(error: unknown, hostile: string): boolean {
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, 'Provider-pinned finality passes are invalid.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(String(error).includes(hostile), false);
  assert.doesNotMatch(String(error), /secret|hostile|invalid\/rpc/u);
  return true;
}

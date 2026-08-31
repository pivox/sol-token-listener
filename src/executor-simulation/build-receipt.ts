import { isProxy } from 'node:util/types';
import type { UnsignedBuildPlanV1 } from './build-plan.js';
import type { ExecutionAccountSnapshot } from '../ports/execution-market-gateway.js';

/** Opaque, ephemeral proof that one authority paired these exact objects. */
export interface ExecutionBuildReceiptV1 {
  readonly payloadVersion: 1;
}

interface ReceiptBinding {
  readonly plan: UnsignedBuildPlanV1;
  readonly snapshot: ExecutionAccountSnapshot;
  consumed: boolean;
}

/**
 * Instance-scoped authority. It intentionally retains only object identities;
 * no plan, transaction, signature, account bytes, or provider data is exposed
 * through a receipt.
 */
export class BuildReceiptAuthority {
  private readonly bindings = new WeakMap<object, ReceiptBinding>();

  public issue(plan: UnsignedBuildPlanV1, snapshot: ExecutionAccountSnapshot): ExecutionBuildReceiptV1 {
    if (!frozenPlainObject(plan) || !frozenPlainObject(snapshot)) throw new TypeError('Invalid build receipt binding.');
    const receipt = Object.freeze(Object.assign(Object.create(null), { payloadVersion: 1 })) as ExecutionBuildReceiptV1;
    this.bindings.set(receipt, { plan, snapshot, consumed: false });
    return receipt;
  }

  public consume(
    receipt: unknown,
    plan: UnsignedBuildPlanV1,
    snapshot: ExecutionAccountSnapshot,
  ): boolean {
    if (!frozenPlainObject(receipt) || !frozenPlainObject(plan) || !frozenPlainObject(snapshot)) return false;
    const binding = this.bindings.get(receipt);
    if (binding === undefined || binding.consumed || binding.plan !== plan || binding.snapshot !== snapshot) return false;
    binding.consumed = true;
    return true;
  }
}

function frozenPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.isFrozen(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

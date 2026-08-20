/**
 * ProductExecutorRegistry.ts — the run seam between a product's eligibility
 * verdict and the core that actually produces it.
 *
 * `ProcessService` decides whether a product MAY be made and issues an
 * unforgeable `ProductAuthorization`; the compute cores (DTM, DSM, contours,
 * change, volume, footprints) already exist. What was missing is the middle: a
 * place that, given a `ProductId`, runs the matching core through the
 * authorization gate. This registry is that place. An executor is invoked only
 * inside `ProcessService.runIfAuthorized`, so a blocked or review-only product
 * cannot be produced by routing through here, and an unregistered product fails
 * closed rather than silently doing nothing.
 */

import type { ProductId, Readiness } from './ProcessPlan';
import type { ProcessService, ProductAuthorization } from './ProcessService';

/**
 * A product's compute step. It receives the caller's context (points, grid
 * params, sibling epoch, etc.) and the authorization proving the product is
 * ready. Sync or async.
 */
export type ProductExecutor<Ctx, Out> = (ctx: Ctx, auth: ProductAuthorization) => Out | Promise<Out>;

/** The outcome of a gated run. */
export type ProductRunResult<Out> =
  | { readonly ran: true; readonly product: ProductId; readonly value: Out }
  | {
      readonly ran: false;
      readonly product: ProductId;
      readonly reasonCode: string;
      readonly reason: string;
      readonly readiness?: Readiness;
    };

export class ProductExecutorRegistry<Ctx> {
  private readonly _executors = new Map<ProductId, ProductExecutor<Ctx, unknown>>();

  /** Register (or replace) the executor for a product. */
  register<Out>(product: ProductId, executor: ProductExecutor<Ctx, Out>): this {
    this._executors.set(product, executor as ProductExecutor<Ctx, unknown>);
    return this;
  }

  has(product: ProductId): boolean {
    return this._executors.has(product);
  }

  get(product: ProductId): ProductExecutor<Ctx, unknown> | undefined {
    return this._executors.get(product);
  }

  /** The products that have an executor, in registration order. */
  products(): ProductId[] {
    return [...this._executors.keys()];
  }

  /**
   * Run a product's core through the service's authorization gate. Returns the
   * executor's value when the product is ready, or a fail-closed refusal (an
   * unregistered product, or the plan's own blocked/review verdict) without ever
   * invoking the executor.
   */
  async run<Out>(
    service: ProcessService,
    product: ProductId,
    ctx: Ctx,
  ): Promise<ProductRunResult<Out>> {
    const executor = this._executors.get(product);
    if (!executor) {
      return {
        ran: false,
        product,
        reasonCode: 'EXECUTOR_UNREGISTERED',
        reason: `No executor is registered for ${product}.`,
      };
    }
    const run = service.runIfAuthorized(product, (auth) => executor(ctx, auth));
    if (!run.authorized) {
      return {
        ran: false,
        product,
        reasonCode: run.reasonCode,
        reason: run.reason,
        readiness: run.readiness,
      };
    }
    return { ran: true, product, value: (await run.value) as Out };
  }
}

/**
 * Enforces the control token at the innermost layer, beneath the policy guard.
 *
 * Placing it innermost is deliberate: an action that policy has already approved must
 * still be refused if a human has taken the wheel. The check has to sit closer to the
 * browser than the approval does.
 */

import { ControlToken, type Controller } from "./control.js";
import type {
  Action,
  ActionResult,
  Observation,
  Resolution,
  Surface,
  SurfaceFingerprint,
} from "../surface/types.js";
import type { ExtractionSpec, LocatorBundle } from "../schema/common.js";

export class ControlledSurface implements Surface {
  readonly kind: Surface["kind"];

  constructor(
    private readonly inner: Surface,
    private readonly control: ControlToken,
    private readonly actingAs: Controller = "automation"
  ) {
    this.kind = inner.kind;
  }

  /** Observation is always permitted; watching a session a human is driving is the point. */
  observe(): Promise<Observation> {
    return this.inner.observe();
  }
  settle(timeoutMs?: number): Promise<void> {
    return this.inner.settle(timeoutMs);
  }
  screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }
  resolve(bundle: LocatorBundle): Promise<Resolution> {
    return this.inner.resolve(bundle);
  }
  describeElement(ref: string): Promise<LocatorBundle> {
    return this.inner.describeElement(ref);
  }
  extract(spec: ExtractionSpec): Promise<string | null> {
    return this.inner.extract(spec);
  }
  fingerprint(): Promise<SurfaceFingerprint> {
    return this.inner.fingerprint();
  }

  async act(action: Action): Promise<ActionResult> {
    this.control.assertHeldBy(this.actingAs);
    return this.inner.act(action);
  }
}

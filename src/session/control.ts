/**
 * Who is driving.
 *
 * The handoff requirement is really a concurrency requirement: automation and a human
 * operator share one live browser session, and if both can act at once the session
 * state becomes unreproducible and the evidence trail becomes a lie.
 *
 * So control is an explicit, single-writer token. It is not advisory - the surface
 * wrapper below rejects any action from a party that does not hold it.
 */

export type Controller = "automation" | "human" | "none";

export class ControlViolation extends Error {
  constructor(readonly attemptedBy: Controller, readonly heldBy: Controller) {
    super(`${attemptedBy} attempted to act while control is held by ${heldBy}.`);
    this.name = "ControlViolation";
  }
}

export interface ControlEvent {
  at: string;
  from: Controller;
  to: Controller;
  reason: string;
}

export class ControlToken {
  private holder: Controller = "automation";
  private readonly history: ControlEvent[] = [];
  private readonly waiters: { want: Controller; resolve: () => void }[] = [];

  get current(): Controller {
    return this.holder;
  }

  get transfers(): readonly ControlEvent[] {
    return this.history;
  }

  isHeldBy(who: Controller): boolean {
    return this.holder === who;
  }

  assertHeldBy(who: Controller): void {
    if (this.holder !== who) throw new ControlViolation(who, this.holder);
  }

  /**
   * Hand control away. Passing through `none` is intentional: between automation
   * pausing and an operator picking the intervention up, nobody is driving, and the
   * evidence should say so rather than implying a human was present all along.
   */
  transfer(to: Controller, reason: string): void {
    if (this.holder === to) return;
    this.history.push({ at: new Date().toISOString(), from: this.holder, to, reason });
    this.holder = to;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.want === to) {
        this.waiters.splice(i, 1)[0]!.resolve();
      }
    }
  }

  /** Block until the named party holds control, or the deadline passes. */
  async waitFor(who: Controller, timeoutMs: number): Promise<boolean> {
    if (this.holder === who) return true;
    return new Promise<boolean>((resolve) => {
      const entry = { want: who, resolve: () => resolve(true) };
      this.waiters.push(entry);
      setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(false);
        }
      }, timeoutMs).unref?.();
    });
  }
}

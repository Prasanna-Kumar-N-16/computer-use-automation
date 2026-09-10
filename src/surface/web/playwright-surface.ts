/**
 * The web implementation of `Surface`, built on Playwright.
 *
 * Its only job is to turn the abstract vocabulary (observe, act on a ref, resolve a
 * locator bundle, extract a value) into browser operations. Nothing above it knows
 * this file exists, which is what keeps a second adapter cheap.
 */

import type { Frame, Page, Response } from "playwright";
import { BROWSER_SCRIPT } from "./browser-script.js";
import type {
  Action,
  ActionResult,
  Observation,
  ObservedElement,
  ObservedGrid,
  Resolution,
  Surface,
  SurfaceFingerprint,
} from "../types.js";
import type { ExtractionSpec, LocatorBundle, LocatorStrategy } from "../../schema/common.js";

/**
 * A ref handed out by this adapter.
 *
 * `doc` is what makes a reference safe to hold across an action: element indices are
 * per-document, so a reference taken before a navigation must be rejected rather than
 * quietly resolved against whatever now occupies that index.
 */
interface RefTarget {
  framePath: string[];
  local: string;
  doc: string;
}

interface RawSnapshot {
  doc: string;
  url: string;
  title: string;
  text: string;
  grids: { headers: string[]; rows: string[][] }[];
  elements: Array<{
    ref: string;
    role: string;
    name: string;
    value?: string;
    labelText?: string;
    visible: boolean;
    enabled: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    meta: Record<string, string>;
  }>;
}

export function framePathOf(frame: Frame): string[] {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    path.unshift(f.name() || "(unnamed)");
    f = f.parentFrame();
  }
  return path;
}

export class PlaywrightSurface implements Surface {
  readonly kind = "web" as const;

  private refs = new Map<string, RefTarget>();
  private lastDocumentStatus: number | undefined;
  /**
   * Counts frame navigations.
   *
   * `waitForLoadState` is not enough after a click: the page has already reached
   * domcontentloaded, so it returns instantly and the caller inspects the screen the
   * click was meant to replace. Counting navigations lets an action wait for the
   * navigation it actually caused - including a POST back to the same URL, which no
   * URL comparison would catch.
   */
  private navigations = 0;

  constructor(private readonly page: Page) {
    page.on("response", (res: Response) => {
      const req = res.request();
      if (req.resourceType() === "document") this.lastDocumentStatus = res.status();
    });
    page.on("framenavigated", () => {
      this.navigations += 1;
    });
  }

  /** Install the perception script into future documents. Call once per page. */
  static async prepare(page: Page): Promise<PlaywrightSurface> {
    await page.addInitScript(BROWSER_SCRIPT);
    return new PlaywrightSurface(page);
  }

  private async ensure(frame: Frame): Promise<void> {
    try {
      const present = await frame.evaluate("typeof window.__cua !== 'undefined'");
      if (!present) await frame.evaluate(BROWSER_SCRIPT);
    } catch {
      // A frame that is mid-navigation will be re-tried on the next observation.
    }
  }

  private findFrame(path: string[]): Frame | undefined {
    if (path.length === 0) return this.page.mainFrame();
    return this.page.frames().find((f) => {
      const p = framePathOf(f);
      return p.length === path.length && p.every((seg, i) => seg === path[i]);
    });
  }

  /**
   * Wait out the navigation an action may have started.
   *
   * `graceMs` bounds how long we wait for one to *begin*; an action that navigates
   * nothing costs only that. Once a navigation is seen, we wait for it to finish and
   * for a brief quiet period, so a redirect chain or a frameset filling its children
   * settles fully before anything looks at the screen.
   */
  private async settleAfterAction(navigationsBefore: number, timeoutMs = 10_000, graceMs = 900): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const graceDeadline = Date.now() + graceMs;

    while (this.navigations === navigationsBefore && Date.now() < graceDeadline) {
      await this.page.waitForTimeout(50);
    }
    if (this.navigations === navigationsBefore) return;

    let seen = this.navigations;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(80);
      if (this.navigations !== seen) {
        seen = this.navigations;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - quietSince >= 240) break;
    }
    await this.settle(Math.max(500, deadline - Date.now()));
  }

  async settle(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    } catch {
      /* a frame that never reaches domcontentloaded is reported by the caller's checkpoint */
    }
    // Frames inside a frameset load independently of the top document.
    for (const frame of this.page.frames()) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        await frame.waitForLoadState("domcontentloaded", { timeout: Math.min(left, 5_000) });
      } catch {
        /* ignore */
      }
    }
  }

  async observe(): Promise<Observation> {
    // References are deliberately not cleared here. A ref produced by `resolve` has to
    // survive the observation the policy layer takes to classify it, and staleness is
    // handled by the document stamp rather than by forgetting.
    const elements: ObservedElement[] = [];
    const frameText: Record<string, string> = {};
    const grids: ObservedGrid[] = [];
    let url = this.page.url();
    let title = "";

    for (const frame of this.page.frames()) {
      await this.ensure(frame);
      const path = framePathOf(frame);
      const key = path.join("/");
      let snap: RawSnapshot;
      try {
        snap = (await frame.evaluate("window.__cua.snapshot()")) as RawSnapshot;
      } catch {
        continue;
      }
      frameText[key] = snap.text;
      for (const g of snap.grids ?? []) grids.push({ framePath: path, headers: g.headers, rows: g.rows });
      if (path.length === 0) {
        url = snap.url;
        title = snap.title;
      }
      for (const e of snap.elements) {
        const ref = key ? `${key}#${e.ref}` : `#${e.ref}`;
        this.refs.set(ref, { framePath: path, local: e.ref, doc: snap.doc });
        elements.push({
          ref,
          role: e.role,
          name: e.name,
          value: e.value,
          labelText: e.labelText,
          framePath: path,
          visible: e.visible,
          enabled: e.enabled,
          bounds: e.bounds,
          meta: e.meta,
        });
      }
    }

    return {
      url,
      title: title || (await this.page.title().catch(() => "")),
      httpStatus: this.lastDocumentStatus,
      elements,
      frameText,
      grids,
      capturedAt: new Date().toISOString(),
    };
  }

  private async currentDoc(frame: Frame): Promise<string | undefined> {
    try {
      return (await frame.evaluate("window.__cua && window.__cua.doc")) as string | undefined;
    } catch {
      return undefined;
    }
  }

  private async handleFor(ref: string) {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`Unknown element reference "${ref}". Observe again before acting.`);
    const frame = this.findFrame(target.framePath);
    if (!frame) throw new Error(`Frame [${target.framePath.join("/")}] is no longer present.`);
    await this.ensure(frame);
    const doc = await this.currentDoc(frame);
    if (doc && doc !== target.doc) {
      throw new Error(
        `Element reference "${ref}" was taken before frame [${target.framePath.join("/") || "top"}] navigated. Observe again before acting.`
      );
    }
    const handle = await frame.evaluateHandle((r) => (window as any).__cua.handleFor(r), target.local);
    const el = handle.asElement();
    if (!el) throw new Error(`Element reference "${ref}" no longer resolves to a live element.`);
    return el;
  }

  async act(action: Action): Promise<ActionResult> {
    switch (action.kind) {
      case "navigate": {
        const res = await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
        if (res) this.lastDocumentStatus = res.status();
        await this.settle();
        return { ok: true, note: `navigated to ${action.url}` };
      }
      case "click": {
        const el = await this.handleFor(action.ref);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const before = this.navigations;
        await el.click({ timeout: 10_000 });
        await this.settleAfterAction(before);
        return { ok: true };
      }
      case "type": {
        const el = await this.handleFor(action.ref);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        if (action.clearFirst !== false) await el.fill("");
        await el.type(action.text, { delay: 12 });
        if (action.pressEnter) {
          const before = this.navigations;
          await el.press("Enter");
          await this.settleAfterAction(before);
        }
        return { ok: true };
      }
      case "select": {
        const el = await this.handleFor(action.ref);
        await el.selectOption(action.value);
        return { ok: true };
      }
      case "press": {
        const before = this.navigations;
        if (action.ref) {
          const el = await this.handleFor(action.ref);
          await el.press(action.key);
        } else {
          await this.page.keyboard.press(action.key);
        }
        await this.settleAfterAction(before);
        return { ok: true };
      }
      case "scroll": {
        const dy = action.direction === "down" ? 400 : -400;
        await this.page.mouse.wheel(0, dy);
        return { ok: true };
      }
      case "wait": {
        await this.page.waitForTimeout(action.ms);
        return { ok: true };
      }
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  /**
   * Try each strategy in the bundle's recorded order and take the first that matches
   * exactly one element.
   *
   * Two rules matter here. A strategy that matches several elements is rejected rather
   * than disambiguated by position - guessing is how automation silently clicks the
   * wrong row. And strategies that resolve to a *different* element than the winner are
   * recorded as disagreements: the run still proceeds, but the artifact has started to
   * drift and the evidence says so.
   */
  async resolve(bundle: LocatorBundle): Promise<Resolution> {
    const frame = this.findFrame(bundle.framePath);
    const attempted: Resolution["attempted"] = [];
    if (!frame) {
      return {
        attempted: [{ kind: "frame", matches: 0, note: `frame [${bundle.framePath.join("/")}] not present` }],
        disagreements: [],
        status: "unresolved",
      };
    }
    await this.ensure(frame);
    const key = bundle.framePath.join("/");

    let winner: { local: string; kind: LocatorStrategy["kind"] } | undefined;
    const singles: { kind: string; local: string }[] = [];
    let sawAmbiguity = false;
    let doc = "";

    for (const strategy of bundle.strategies) {
      let refs: string[] = [];
      try {
        const outcome = (await frame.evaluate((s) => (window as any).__cua.resolve(s), strategy)) as {
          doc: string;
          refs: number[];
        };
        doc = outcome.doc;
        refs = outcome.refs.map(String);
      } catch (err) {
        attempted.push({ kind: strategy.kind, matches: 0, note: String(err).slice(0, 120) });
        continue;
      }
      attempted.push({ kind: strategy.kind, matches: refs.length });
      if (refs.length === 1) {
        const local = refs[0]!;
        singles.push({ kind: strategy.kind, local });
        if (!winner) winner = { local, kind: strategy.kind };
      } else if (refs.length > 1) {
        sawAmbiguity = true;
      }
    }

    if (!winner) {
      return { attempted, disagreements: [], status: sawAmbiguity ? "ambiguous" : "unresolved" };
    }

    const disagreements = singles.filter((s) => s.local !== winner!.local).map((s) => s.kind);
    const ref = key ? `${key}#${winner.local}` : `#${winner.local}`;
    this.refs.set(ref, { framePath: bundle.framePath, local: winner.local, doc });

    return { ref, resolvedBy: winner.kind, attempted, disagreements, status: "resolved" };
  }

  async describeElement(ref: string): Promise<LocatorBundle> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`Unknown element reference "${ref}".`);
    const frame = this.findFrame(target.framePath);
    if (!frame) throw new Error(`Frame [${target.framePath.join("/")}] is no longer present.`);
    await this.ensure(frame);
    const built = (await frame.evaluate(
      (r) => (window as any).__cua.describeLocator(r),
      target.local
    )) as { description: string; strategies: LocatorStrategy[] } | null;
    if (!built) throw new Error(`Could not build a locator for "${ref}".`);
    return { description: built.description, framePath: target.framePath, strategies: built.strategies };
  }

  async extract(spec: ExtractionSpec): Promise<string | null> {
    if (spec.kind === "literal") return spec.value;

    const framePath = spec.kind === "element_text" ? spec.locator.framePath : spec.framePath;
    const frame = this.findFrame(framePath);
    if (!frame) return null;
    await this.ensure(frame);

    if (spec.kind === "table_cell") {
      return (await frame.evaluate((s) => (window as any).__cua.tableCell(s), spec)) as string | null;
    }

    if (spec.kind === "element_text") {
      const res = await this.resolve(spec.locator);
      if (res.status !== "resolved" || !res.ref) return null;
      const target = this.refs.get(res.ref)!;
      return (await frame.evaluate((r) => (window as any).__cua.elementText(r), target.local)) as string | null;
    }

    // regex_capture
    let haystack: string | null;
    if (spec.locator) {
      const res = await this.resolve(spec.locator);
      if (res.status !== "resolved" || !res.ref) return null;
      const target = this.refs.get(res.ref)!;
      haystack = (await frame.evaluate((r) => (window as any).__cua.elementText(r), target.local)) as string | null;
    } else {
      haystack = (await frame.evaluate("window.__cua.pageText()")) as string;
    }
    if (!haystack) return null;
    const m = new RegExp(spec.pattern).exec(haystack);
    return m ? m[spec.group] ?? null : null;
  }

  /** Read the frame's visible text, for text assertions. */
  async frameText(framePath: string[]): Promise<string> {
    const frame = this.findFrame(framePath);
    if (!frame) return "";
    await this.ensure(frame);
    try {
      return (await frame.evaluate("window.__cua.pageText()")) as string;
    } catch {
      return "";
    }
  }

  async allText(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      await this.ensure(frame);
      try {
        parts.push((await frame.evaluate("window.__cua.pageText()")) as string);
      } catch {
        /* ignore */
      }
    }
    return parts.join("\n");
  }

  async fingerprint(): Promise<SurfaceFingerprint> {
    const text = await this.allText();
    const m = /MeridianCore Servicing\s+v([\d.]+)/.exec(text);
    let structureHash: string | undefined;
    const content = this.page.frames().find((f) => framePathOf(f).length > 0) ?? this.page.mainFrame();
    await this.ensure(content);
    try {
      structureHash = (await content.evaluate("window.__cua.structureSignature()")) as string;
    } catch {
      /* ignore */
    }
    return {
      appName: m ? "MeridianCore Servicing" : undefined,
      appVersion: m?.[1],
      entryTitle: await this.page.title().catch(() => undefined),
      structureHash,
    };
  }

  get lastStatus(): number | undefined {
    return this.lastDocumentStatus;
  }

  get playwrightPage(): Page {
    return this.page;
  }
}

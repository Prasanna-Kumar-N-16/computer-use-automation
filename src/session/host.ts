/**
 * The session host owns the live browser for the lifetime of a run.
 *
 * It exists so that "the automation's session" and "the session a human takes over"
 * are the same object. Nothing else in the system launches a browser; discovery,
 * replay, and the operator console all reach the surface through here.
 */

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { GuardedSurface, type GuardedSurfaceOptions, type PolicyEngine } from "../policy/engine.js";
import { PlaywrightSurface } from "../surface/web/playwright-surface.js";
import { ControlToken } from "./control.js";
import { ControlledSurface } from "./controlled-surface.js";
import { EvidenceRecorder } from "./evidence.js";
import type { Surface } from "../surface/types.js";

export interface SessionHostOptions {
  baseUrl: string;
  policy: PolicyEngine;
  evidenceRoot: string;
  runId?: string;
  headless?: boolean;
  operatorId?: string;
  password?: string;
  viewport?: { width: number; height: number };
}

export class SessionHost {
  readonly runId: string;
  readonly control = new ControlToken();
  readonly evidence: EvidenceRecorder;

  private browser?: Browser;
  private context?: BrowserContext;
  private pageRef?: Page;
  private raw?: PlaywrightSurface;
  private cdp?: CDPSession;

  constructor(private readonly options: SessionHostOptions) {
    this.runId = options.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
    this.evidence = new EvidenceRecorder(options.evidenceRoot, this.runId, options.policy.redactor);
    // Credentials are registered before the browser starts, so there is no window in
    // which the password could reach a log line unredacted.
    if (options.password) options.policy.redactor.registerSecret(options.password, "operator_password");
  }

  get page(): Page {
    if (!this.pageRef) throw new Error("Session not started.");
    return this.pageRef;
  }

  get surface(): PlaywrightSurface {
    if (!this.raw) throw new Error("Session not started.");
    return this.raw;
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 900 },
    });
    this.pageRef = await this.context.newPage();
    this.raw = await PlaywrightSurface.prepare(this.pageRef);
    this.evidence.event("run_started", `Session ${this.runId} started against ${this.options.baseUrl}`, {
      baseUrl: this.options.baseUrl,
      headless: this.options.headless ?? true,
    });
  }

  /**
   * Build the surface the automation acts through.
   *
   * The composition order is the security model: control enforcement innermost,
   * then policy, so an action must satisfy both, and a human holding the wheel
   * overrides an approval that policy already granted.
   */
  automationSurface(options: GuardedSurfaceOptions): GuardedSurface {
    const controlled: Surface = new ControlledSurface(this.surface, this.control, "automation");
    return new GuardedSurface(controlled, this.options.policy, options);
  }

  /**
   * Sign on.
   *
   * Authentication is a platform precondition, never a recorded step. Capability
   * artifacts declare `requires: [authenticated_session]` and know nothing about
   * credentials, which is what makes it structurally impossible for a credential to
   * end up in an artifact file.
   */
  async signOn(): Promise<void> {
    const operatorId = this.options.operatorId ?? "OPR01";
    const password = this.options.password ?? "demo";
    const page = this.page;

    const verdict = this.options.policy.checkNavigation(this.options.baseUrl);
    if (!verdict.allowed) throw new Error(`Base URL refused by policy: ${verdict.reason}`);

    await page.goto(this.options.baseUrl, { waitUntil: "domcontentloaded" });
    await this.surface.settle();

    const observation = await this.surface.observe();
    const user = observation.elements.find((e) => e.meta?.["controlName"] === "txtUser");
    const pass = observation.elements.find((e) => e.meta?.["controlName"] === "txtPass");
    const submit = observation.elements.find((e) => e.meta?.["controlName"] === "cmdSignon");

    if (!user || !pass || !submit) {
      // Already signed on, or the sign-on screen changed shape.
      this.evidence.event("precondition", "Sign-on screen not presented; assuming an existing session.");
      return;
    }

    await this.surface.act({ kind: "type", ref: user.ref, text: operatorId });
    await this.surface.act({ kind: "type", ref: pass.ref, text: password });
    await this.surface.act({ kind: "click", ref: submit.ref });
    await this.surface.settle();

    this.evidence.event("precondition", `Signed on as operator ${operatorId}.`, { operatorId });
  }

  /** True when the app is showing its session-timeout screen rather than content. */
  async isSignedOn(): Promise<boolean> {
    const text = await this.surface.allText();
    return !/session has timed out|Sign On/i.test(text) || /Relationship Summary|Member Inquiry/i.test(text);
  }

  // ------------------------------------------------------------- live handoff

  /** Chrome DevTools Protocol session, used to stream the page and inject operator input. */
  async cdpSession(): Promise<CDPSession> {
    if (!this.cdp) {
      if (!this.context || !this.pageRef) throw new Error("Session not started.");
      this.cdp = await this.context.newCDPSession(this.pageRef);
    }
    return this.cdp;
  }

  async close(): Promise<void> {
    this.evidence.event("run_finished", `Session ${this.runId} closed.`);
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

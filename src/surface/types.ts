/**
 * The surface contract.
 *
 * Everything above this file - the discovery agent, the replay engine, the policy
 * layer - is written against these types and never against Playwright. That is
 * deliberate: it is the seam that lets a desktop accessibility-tree adapter or a
 * screenshot-and-coordinates adapter slot in without touching the artifact schema or
 * the executor.
 *
 * The model, likewise, only ever sees `ObservedElement.ref`. It cannot express a CSS
 * selector even if it wants to.
 */

import type { ExtractionSpec, LocatorBundle, LocatorStrategy } from "../schema/common.js";

/** A control or piece of content the surface is currently exposing. */
export interface ObservedElement {
  /** Opaque handle, valid only for the life of the observation that produced it. */
  ref: string;
  role: string;
  /** Accessible name, or the best legacy substitute the adapter could compute. */
  name: string;
  value?: string;
  /** Label text found by spatial/table association, when no real label exists. */
  labelText?: string;
  /** Frame name chain from the top document. Empty means the top document. */
  framePath: string[];
  visible: boolean;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  /** Adapter-specific detail, surfaced for locator building. Never shown to the model raw. */
  meta?: Record<string, string>;
}

/** A data grid as the operator sees it: column headers plus the rows underneath. */
export interface ObservedGrid {
  framePath: string[];
  headers: string[];
  rows: string[][];
}

export interface Observation {
  url: string;
  title: string;
  /** HTTP status of the last main-frame navigation, when the adapter can know it. */
  httpStatus?: number;
  elements: ObservedElement[];
  /** Visible text per frame, keyed by joined frame path. Used for text assertions. */
  frameText: Record<string, string>;
  /** Tabular structure per frame, so a grid value can be addressed by header and row. */
  grids: ObservedGrid[];
  capturedAt: string;
}

export type Action =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; clearFirst?: boolean; pressEnter?: boolean }
  | { kind: "select"; ref: string; value: string }
  | { kind: "press"; key: string; ref?: string };

export interface ActionResult {
  ok: boolean;
  note?: string;
}

/** Outcome of resolving a locator bundle, including the evidence for why. */
export interface Resolution {
  ref?: string;
  resolvedBy?: LocatorStrategy["kind"];
  attempted: { kind: string; matches: number; note?: string }[];
  /** Strategies that matched exactly one element, but a *different* one than the winner. */
  disagreements: string[];
  status: "resolved" | "unresolved" | "ambiguous";
}

/** Structural signature of a screen, used for drift detection and tenant matching. */
export interface SurfaceFingerprint {
  appName?: string;
  appVersion?: string;
  entryTitle?: string;
  structureHash?: string;
}

export interface Surface {
  readonly kind: "web" | "desktop" | "terminal";

  observe(): Promise<Observation>;
  act(action: Action): Promise<ActionResult>;
  screenshot(): Promise<Buffer>;

  /** Block until the surface is quiescent enough to observe or act on. */
  settle(timeoutMs?: number): Promise<void>;

  /** Resolve a recorded locator bundle against the current state. */
  resolve(bundle: LocatorBundle): Promise<Resolution>;

  /** Build a durable locator bundle for an element seen in the current state. */
  describeElement(ref: string): Promise<LocatorBundle>;

  /** Read a declared output value off the current state. */
  extract(spec: ExtractionSpec): Promise<string | null>;

  /** Cheap structural signature of the current screen, for drift detection. */
  fingerprint(): Promise<SurfaceFingerprint>;
}

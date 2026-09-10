/**
 * Shared vocabulary for capability artifacts: how a control is found, how a
 * condition is asserted, and how a value is pulled off the screen.
 *
 * Three rules shape everything here:
 *
 *  1. Nothing in this file is surface-specific. There is no CSS, no XPath, no
 *     Playwright. A locator is a *description* of a control; resolving it is the
 *     surface adapter's job. That is the seam that lets the same artifact target a
 *     browser today and a desktop accessibility tree later.
 *
 *  2. Assertions are declarative data, never code. Artifacts are reviewed by humans
 *     and executed unattended against regulated systems; an artifact must never be
 *     able to smuggle in executable logic.
 *
 *  3. A locator is a *bundle* of independent signals, ordered most-robust-first.
 *     Legacy screens give you several weak signals rather than one strong one, and
 *     agreement between weak signals is what produces confidence.
 */

import { z } from "zod";

// --------------------------------------------------------------------- locators

/**
 * One way of finding a control. Ordered by how well each survives the kinds of
 * change these applications actually undergo (rebranding, version upgrades,
 * per-tenant configuration) rather than by convenience.
 */
export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  /** Accessible role + name. Best signal when the app exposes one. */
  z.object({
    kind: z.literal("role_name"),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(false),
  }),

  /**
   * The legacy form-control `name` attribute (txtMbrNo, cmdSearch). Ugly, but in
   * server-rendered enterprise apps it is load-bearing: the server reads it, so it
   * cannot be changed casually. In practice this is the single most durable signal
   * on these screens.
   */
  z.object({ kind: z.literal("control_name"), name: z.string() }),

  z.object({ kind: z.literal("control_id"), id: z.string() }),

  /**
   * Relational anchor: the control sitting in the same table row (or immediately
   * after) a cell whose text reads `labelText`. Table-layout screens almost never
   * use <label for>, so this reconstructs the association a human makes visually.
   */
  z.object({
    kind: z.literal("label_anchor"),
    labelText: z.string(),
    controlType: z.string().optional(),
    relation: z.enum(["same_row", "following", "same_cell"]).default("same_row"),
  }),

  /** A control identified by its own visible text, e.g. a link or a button value. */
  z.object({
    kind: z.literal("text_anchor"),
    text: z.string(),
    role: z.string().optional(),
    exact: z.boolean().default(false),
  }),

  z.object({
    kind: z.literal("attribute"),
    attr: z.string(),
    value: z.string(),
    tag: z.string().optional(),
  }),

  /** Structural position. Brittle by nature; kept as a late fallback only. */
  z.object({
    kind: z.literal("dom_path"),
    path: z.string(),
    ordinal: z.number().int().nonnegative().default(0),
  }),

  /**
   * Viewport-relative geometry, retained so a pixel-only surface (screenshot +
   * coordinates, or a desktop app with no accessibility tree) has something to use.
   * Never preferred on a surface that exposes structure.
   */
  z.object({
    kind: z.literal("bounds"),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    viewportWidth: z.number(),
    viewportHeight: z.number(),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorBundleSchema = z.object({
  /** Human-readable, so a reviewer can read the artifact without decoding strategies. */
  description: z.string(),
  /** Frame name chain from the top document, e.g. ["mainFrame"]. Empty = top document. */
  framePath: z.array(z.string()).default([]),
  /** Ordered most-robust-first. Replay takes the first strategy that matches exactly one element. */
  strategies: z.array(LocatorStrategySchema).min(1),
});
export type LocatorBundle = z.infer<typeof LocatorBundleSchema>;

// ------------------------------------------------------------------- assertions

export type Assertion =
  | { kind: "text_present"; text: string; framePath?: string[]; caseSensitive?: boolean }
  | { kind: "text_absent"; text: string; framePath?: string[]; caseSensitive?: boolean }
  | { kind: "element_present"; locator: LocatorBundle }
  | { kind: "element_absent"; locator: LocatorBundle }
  | { kind: "url_matches"; pattern: string }
  | { kind: "title_matches"; pattern: string }
  | { kind: "http_status"; equals?: number; atLeast?: number }
  | { kind: "all_of"; of: Assertion[] }
  | { kind: "any_of"; of: Assertion[] }
  | { kind: "not"; of: Assertion };

export const AssertionSchema: z.ZodType<Assertion> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text_present"),
      text: z.string(),
      framePath: z.array(z.string()).optional(),
      caseSensitive: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("text_absent"),
      text: z.string(),
      framePath: z.array(z.string()).optional(),
      caseSensitive: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("element_present"), locator: LocatorBundleSchema }),
    z.object({ kind: z.literal("element_absent"), locator: LocatorBundleSchema }),
    z.object({ kind: z.literal("url_matches"), pattern: z.string() }),
    z.object({ kind: z.literal("title_matches"), pattern: z.string() }),
    z.object({ kind: z.literal("http_status"), equals: z.number().optional(), atLeast: z.number().optional() }),
    z.object({ kind: z.literal("all_of"), of: z.array(AssertionSchema) }),
    z.object({ kind: z.literal("any_of"), of: z.array(AssertionSchema) }),
    z.object({ kind: z.literal("not"), of: AssertionSchema }),
  ]) as unknown as z.ZodType<Assertion>
);

// ------------------------------------------------------------------- extraction

/** Post-processing applied to a raw scraped string before it is typed. */
export const TransformSchema = z.enum(["none", "trim", "money", "digits", "number"]).default("trim");
export type Transform = z.infer<typeof TransformSchema>;

/**
 * How to read a value off the screen.
 *
 * `table_cell` is the interesting one. On a legacy grid, "the current balance of the
 * savings account" is not a stable DOM position - it is the intersection of a column
 * header and a row identified by another cell's value. Encoding that relationship
 * directly is far more robust than any path, and it survives rows being added,
 * reordered, or filtered.
 */
export const ExtractionSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("element_text"),
    locator: LocatorBundleSchema,
    transform: TransformSchema,
  }),
  z.object({
    kind: z.literal("table_cell"),
    framePath: z.array(z.string()).default([]),
    /** Identifies the grid: a table containing all of these header texts. */
    tableHeaders: z.array(z.string()).min(1),
    /** Picks the row: the row whose cell under `rowMatchColumn` satisfies the match. */
    rowMatchColumn: z.string(),
    rowMatchValue: z.string(),
    rowMatchMode: z.enum(["equals", "contains"]).default("equals"),
    /** Picks the cell within that row, by column header text. */
    valueColumn: z.string(),
    transform: TransformSchema,
  }),
  z.object({
    kind: z.literal("regex_capture"),
    framePath: z.array(z.string()).default([]),
    /** Omit `locator` to search the whole frame's visible text. */
    locator: LocatorBundleSchema.optional(),
    pattern: z.string(),
    group: z.number().int().nonnegative().default(1),
    transform: TransformSchema,
  }),
  z.object({
    kind: z.literal("literal"),
    value: z.string(),
    transform: TransformSchema,
  }),
]);
export type ExtractionSpec = z.infer<typeof ExtractionSpecSchema>;

// ------------------------------------------------------------------------ values

/**
 * Where a step gets the text it types.
 *
 * `secret_ref` never carries the value itself - only the name of a credential the
 * runtime resolves from configuration. That is what keeps credentials structurally
 * incapable of reaching an artifact file.
 */
export const ValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("param"), name: z.string() }),
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("secret_ref"), name: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

/**
 * The operator console.
 *
 * This is the part of the brief that is easy to fake and pointless to fake. The
 * console does not open a fresh browser or replay a recording - it attaches to the
 * *same* live Chrome DevTools Protocol session the automation was driving, streams it
 * to the operator, and injects their mouse and keyboard events back into it.
 *
 * Consequences worth noticing:
 *   - the operator inherits the real session cookie, scroll position, and form state
 *   - every event they generate passes through this process, so recording what the
 *     human did is exact rather than inferred
 *   - control is transferred through the same token the automation respects, so the
 *     automation genuinely cannot act while the operator is working
 *
 * Deliberately bare: one list, one canvas, three buttons. The mechanism is the
 * deliverable, not the styling.
 */

import express from "express";
import type { Server } from "node:http";
import type { CDPSession } from "playwright";
import type { SessionHost } from "../session/host.js";
import type { InterventionDecision, InterventionStore } from "./store.js";

interface ScreencastFrame {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number; pageScaleFactor: number };
  sessionId: number;
}

export interface OperatorConsoleOptions {
  port: number;
  host: SessionHost;
  store: InterventionStore;
}

export class OperatorConsole {
  private server?: Server;
  private cdp?: CDPSession;
  private streaming = false;
  private clients = new Set<express.Response>();

  constructor(private readonly options: OperatorConsoleOptions) {}

  get url(): string {
    return `http://localhost:${this.options.port}`;
  }

  async start(): Promise<void> {
    const { host, store } = this.options;
    const app = express();
    app.use(express.json());

    app.get("/", (_req, res) => {
      res.type("html").send(indexPage(store.list(), host.control.current, host.runId));
    });

    app.get("/i/:id", (req, res) => {
      const item = store.get(req.params.id);
      if (!item) return res.status(404).type("html").send("<p>No such intervention.</p>");
      res.type("html").send(takeoverPage(item, host.control.current));
    });

    /**
     * Claiming transfers control. Until an operator claims, control sits at `none`:
     * automation has stopped but nobody has picked it up, and the evidence should be
     * able to distinguish "waiting for a human" from "a human is working".
     */
    app.post("/i/:id/claim", (req, res) => {
      const operator = String(req.body?.operator ?? "operator");
      const item = store.claim(req.params.id, operator);
      if (!item) return res.status(404).json({ error: "not_found" });
      host.control.transfer("human", `intervention ${item.id} claimed by ${operator}`);
      host.evidence.event("control_transfer", `Control transferred to human operator ${operator}.`, {
        interventionId: item.id,
        operator,
      });
      res.json({ ok: true, control: host.control.current });
    });

    app.get("/i/:id/stream", async (req, res) => {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      this.clients.add(res);
      await this.ensureStreaming();
      req.on("close", () => {
        this.clients.delete(res);
        if (this.clients.size === 0) void this.stopStreaming();
      });
    });

    /** Relay one operator input event into the live session. */
    app.post("/i/:id/input", async (req, res) => {
      const item = store.get(req.params.id);
      if (!item) return res.status(404).json({ error: "not_found" });
      if (!host.control.isHeldBy("human")) {
        return res.status(409).json({ error: "control_not_held", control: host.control.current });
      }
      try {
        const describe = await this.dispatch(req.body);
        store.recordHumanAction(item.id, describe);
        host.evidence.event("human_action", describe, { interventionId: item.id });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    /** Hand control back and unblock the waiting run. */
    app.post("/i/:id/resolve", (req, res) => {
      const decision = String(req.body?.decision ?? "resume") as InterventionDecision;
      const operator = String(req.body?.operator ?? "operator");
      const note = req.body?.note ? String(req.body.note) : undefined;
      const item = store.resolve(req.params.id, decision, operator, note);
      if (!item) return res.status(404).json({ error: "not_found" });

      const back = decision === "abort" || decision === "deny" || decision === "fail" ? "none" : "automation";
      host.control.transfer(back, `intervention ${item.id} resolved as ${decision} by ${operator}`);
      host.evidence.event("intervention_resolved", `Intervention ${item.id} resolved as ${decision}.`, {
        interventionId: item.id,
        decision,
        operator,
        note,
        humanActions: item.humanActions.length,
      });
      res.json({ ok: true, decision, control: host.control.current });
    });

    app.get("/api/interventions", (_req, res) => res.json(this.options.store.list()));

    await new Promise<void>((resolve) => {
      this.server = app.listen(this.options.port, () => resolve());
    });
  }

  private async ensureStreaming(): Promise<void> {
    if (this.streaming) return;
    this.cdp = await this.options.host.cdpSession();
    this.cdp.on("Page.screencastFrame", async (frame: ScreencastFrame) => {
      for (const client of this.clients) {
        client.write(`data: ${JSON.stringify({ data: frame.data, metadata: frame.metadata })}\n\n`);
      }
      // Chrome stops sending frames until each one is acknowledged.
      await this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 1,
    });
    this.streaming = true;
  }

  private async stopStreaming(): Promise<void> {
    if (!this.streaming || !this.cdp) return;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.streaming = false;
  }

  /**
   * Turn one operator gesture into CDP input.
   *
   * `Input.insertText` is used for ordinary typing because it behaves correctly for
   * any character without needing a virtual key-code table; real key events are still
   * used for the keys that carry semantics (Enter submits a form, Tab moves focus).
   */
  private async dispatch(body: any): Promise<string> {
    const cdp = await this.options.host.cdpSession();
    const kind = String(body?.kind ?? "");

    if (kind === "click") {
      const x = Number(body.x);
      const y = Number(body.y);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return `clicked at (${Math.round(x)}, ${Math.round(y)})`;
    }
    if (kind === "text") {
      const text = String(body.text ?? "");
      await cdp.send("Input.insertText", { text });
      return `typed ${text.length} character(s)`;
    }
    if (kind === "key") {
      const key = String(body.key ?? "");
      const map: Record<string, { code: string; vk: number; text?: string }> = {
        Enter: { code: "Enter", vk: 13, text: "\r" },
        Tab: { code: "Tab", vk: 9 },
        Backspace: { code: "Backspace", vk: 8 },
        Escape: { code: "Escape", vk: 27 },
        ArrowDown: { code: "ArrowDown", vk: 40 },
        ArrowUp: { code: "ArrowUp", vk: 38 },
      };
      const spec = map[key];
      if (!spec) return `ignored unsupported key ${key}`;
      const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
      await cdp.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, text: spec.text });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return `pressed ${key}`;
    }
    if (kind === "scroll") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(body.x ?? 100),
        y: Number(body.y ?? 100),
        deltaX: 0,
        deltaY: Number(body.deltaY ?? 200),
      });
      return `scrolled ${body.deltaY}px`;
    }
    return `ignored unknown input ${kind}`;
  }

  async stop(): Promise<void> {
    await this.stopStreaming();
    for (const c of this.clients) c.end();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

// ------------------------------------------------------------------------ views

const STYLE = `<style>
 body{font:13px -apple-system,Segoe UI,sans-serif;margin:0;background:#16181d;color:#e6e6e6}
 header{padding:10px 16px;background:#22252c;border-bottom:1px solid #333;display:flex;gap:16px;align-items:center}
 h1{font-size:14px;margin:0;font-weight:600}
 .pill{padding:2px 8px;border-radius:10px;font-size:11px;background:#333}
 .pill.human{background:#7a4b00}.pill.automation{background:#14503a}.pill.none{background:#5a1f1f}
 main{padding:16px;max-width:1340px}
 table{border-collapse:collapse;width:100%}
 td,th{border-bottom:1px solid #2c2f36;padding:7px 10px;text-align:left;font-size:12px}
 a{color:#7ab8ff}
 .ctx{background:#1d2027;border:1px solid #2c2f36;padding:10px 14px;margin-bottom:12px;font-size:12px;line-height:1.7}
 .ctx b{color:#9fb4c7;font-weight:600}
 #screen{border:1px solid #444;background:#000;cursor:crosshair;max-width:100%}
 button{font:12px inherit;padding:5px 12px;margin-right:8px;background:#2c313a;color:#e6e6e6;
        border:1px solid #444;border-radius:4px;cursor:pointer}
 button.go{background:#14503a;border-color:#1c7a58}
 button.stop{background:#5a1f1f;border-color:#8a3030}
 #log{font-family:ui-monospace,monospace;font-size:11px;color:#8d949e;margin-top:10px;
      max-height:130px;overflow:auto;white-space:pre-wrap}
</style>`;

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function indexPage(items: ReturnType<InterventionStore["list"]>, control: string, runId: string): string {
  const rows = items.length
    ? items
        .map(
          (i) => `<tr>
            <td><a href="/i/${i.id}">${i.id}</a></td>
            <td>${esc(i.kind)}</td>
            <td>${esc(i.capabilityId ?? i.goal ?? "-")}</td>
            <td>${esc(i.context.stepId ?? "-")}</td>
            <td>${esc(i.reason)}</td>
            <td>${i.state}${i.resolution ? ` (${i.resolution.decision})` : ""}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" style="color:#777">No interventions raised.</td></tr>`;
  return `<html><head><title>Operator Console</title>${STYLE}</head><body>
    <header><h1>Operator Console</h1>
      <span class="pill">run ${esc(runId)}</span>
      <span class="pill ${control}">control: ${control}</span></header>
    <main>
      <table><tr><th>ID</th><th>Kind</th><th>Capability</th><th>Step</th><th>Reason</th><th>State</th></tr>
      ${rows}</table>
    </main></body></html>`;
}

function takeoverPage(item: ReturnType<InterventionStore["get"]> & object, control: string): string {
  const c = item.context;
  return `<html><head><title>Intervention ${item.id}</title>${STYLE}</head><body>
  <header><h1>Intervention ${item.id}</h1>
    <span class="pill">${esc(item.kind)}</span>
    <span class="pill ${control}" id="ctl">control: ${control}</span>
    <a href="/">&larr; all interventions</a></header>
  <main>
    <div class="ctx">
      <div><b>Capability</b> ${esc(item.capabilityId ?? item.goal ?? "-")}${item.capabilityVersion ? ` v${item.capabilityVersion}` : ""}</div>
      <div><b>Step</b> ${esc(c.stepId ?? "-")} &mdash; ${esc(c.stepIntent ?? "-")}</div>
      <div><b>Stopped because</b> ${esc(item.reason)}</div>
      <div><b>Expected</b> ${esc(c.expected ?? "-")}</div>
      <div><b>Observed</b> ${esc(c.observed ?? "-")}</div>
      <div><b>At</b> ${esc(c.url ?? "-")}</div>
    </div>

    <div>
      <button class="go" id="claim">Take control</button>
      <button id="resume">Hand back &amp; resume</button>
      <button class="stop" id="abort">Abort run</button>
      <span id="hint" style="color:#8d949e"></span>
    </div>

    <p style="color:#8d949e;font-size:12px">
      Click the screen to click the live page. Type to send text. Enter, Tab, Backspace and
      Escape are relayed as real key events.
    </p>
    <img id="screen" width="1280">
    <div id="log"></div>
  </main>
  <script>
    var id = ${JSON.stringify(item.id)};
    var img = document.getElementById('screen');
    var log = document.getElementById('log');
    var meta = { deviceWidth: 1280, deviceHeight: 900 };
    var claimed = false;

    function say(m){ log.textContent = (new Date().toLocaleTimeString()+'  '+m+'\\n') + log.textContent; }

    new EventSource('/i/'+id+'/stream').onmessage = function(ev){
      var f = JSON.parse(ev.data);
      img.src = 'data:image/jpeg;base64,' + f.data;
      if (f.metadata) meta = f.metadata;
    };

    function send(body){
      return fetch('/i/'+id+'/input', {method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)}).then(function(r){ return r.json(); }).then(function(j){
          if (j.error) say('refused: ' + j.error + (j.control ? ' (control: '+j.control+')' : ''));
        });
    }

    document.getElementById('claim').onclick = function(){
      fetch('/i/'+id+'/claim',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({operator:'console-operator'})})
        .then(function(r){return r.json();}).then(function(j){
          claimed = true;
          document.getElementById('ctl').textContent = 'control: ' + j.control;
          document.getElementById('ctl').className = 'pill ' + j.control;
          say('control taken; automation is now blocked');
        });
    };

    function resolve(decision){
      fetch('/i/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({decision:decision, operator:'console-operator'})})
        .then(function(r){return r.json();}).then(function(j){
          document.getElementById('ctl').textContent = 'control: ' + j.control;
          document.getElementById('ctl').className = 'pill ' + j.control;
          say('resolved as ' + decision + '; control returned to ' + j.control);
        });
    }
    document.getElementById('resume').onclick = function(){ resolve('resume'); };
    document.getElementById('abort').onclick  = function(){ resolve('abort'); };

    // Screencast frames are scaled to fit; map the click back into viewport CSS pixels.
    img.addEventListener('click', function(e){
      var r = img.getBoundingClientRect();
      var x = (e.clientX - r.left) * (meta.deviceWidth  / r.width);
      var y = (e.clientY - r.top)  * (meta.deviceHeight / r.height);
      send({kind:'click', x:x, y:y});
      say('click -> ('+Math.round(x)+','+Math.round(y)+')');
    });

    document.addEventListener('keydown', function(e){
      if (!claimed) return;
      if (['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown'].indexOf(e.key) >= 0){
        e.preventDefault(); send({kind:'key', key:e.key}); say('key ' + e.key);
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey){
        e.preventDefault(); send({kind:'text', text:e.key});
      }
    });
  </script>
  </body></html>`;
}

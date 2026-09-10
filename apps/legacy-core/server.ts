/**
 * MeridianCore Servicing - a stand-in for the legacy back-office applications this
 * system is really aimed at. Server-rendered, frameset-based, no API.
 *
 * The /dev/* routes are an injection surface used by the evidence runs to force
 * specific runtime conditions (session expiry, a broadcast interstitial, a slow
 * screen) on demand, so error handling can be demonstrated deterministically
 * rather than waited for.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { APP_NAME, APP_VERSION, MEMBERS, behaviourFor, SUB_ACCOUNT_PRODUCTS } from "./seed.js";
import * as V from "./views.js";

const PORT = Number(process.env["LEGACY_CORE_PORT"] ?? 4173);
const PASSWORD = process.env["LEGACY_CORE_PASSWORD"] ?? "demo";
const COOKIE = "SVCSESS";

interface Session { id: string; operator: string }

const sessions = new Map<string, Session>();

/** Mutable knobs driven by the /dev/* routes. */
const inject = {
  slowRemaining: 0,
  slowMs: 6000,
  interstitialRemaining: 0,
  /** Invalidate every session after this many more content-frame requests. -1 disables. */
  expireAfter: -1,
};

function resetInjection(): void {
  inject.slowRemaining = 0;
  inject.slowMs = 6000;
  inject.interstitialRemaining = 0;
  inject.expireAfter = -1;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

function currentSession(req: express.Request): Session | undefined {
  const id = readCookie(req.headers.cookie, COOKIE);
  return id ? sessions.get(id) : undefined;
}

/** Consume one armed interstitial, if any. Member 55555 always carries one. */
function takeInterstitial(memberNumber?: string): boolean {
  if (memberNumber && behaviourFor(memberNumber) === "interstitial") return true;
  if (inject.interstitialRemaining > 0) {
    inject.interstitialRemaining -= 1;
    return true;
  }
  return false;
}

async function maybeDelay(): Promise<void> {
  if (inject.slowRemaining > 0) {
    inject.slowRemaining -= 1;
    await new Promise((r) => setTimeout(r, inject.slowMs));
  }
}

// ---------------------------------------------------------------- sign on / off

app.get("/", (req, res) => {
  if (currentSession(req)) return res.redirect("/desk");
  res.type("html").send(V.loginPage());
});

app.post("/signon", (req, res) => {
  const operator = String(req.body?.txtUser ?? "").trim();
  const password = String(req.body?.txtPass ?? "");
  if (!operator || password !== PASSWORD) {
    return res.status(200).type("html").send(V.loginPage("Sign on failed. Check your operator ID and password."));
  }
  const id = randomUUID();
  sessions.set(id, { id, operator });
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect("/desk");
});

app.get("/signoff", (req, res) => {
  const id = readCookie(req.headers.cookie, COOKIE);
  if (id) sessions.delete(id);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`);
  res.redirect("/");
});

app.get("/desk", (req, res) => {
  if (!currentSession(req)) return res.redirect("/");
  res.type("html").send(V.desktop());
});

// ---------------------------------------------------------------- content frames

/**
 * Every content frame is session-guarded. An expired session renders the timeout
 * screen *inside the frame* rather than redirecting, which is exactly how these
 * applications behave and what the replay interceptor has to recognise.
 */
app.use("/frame", (req, res, next) => {
  // Armed timeout: lets a replay be interrupted mid-flow at a known point, so session
  // expiry can be demonstrated deterministically instead of waited for.
  if (inject.expireAfter >= 0) {
    if (inject.expireAfter === 0) {
      sessions.clear();
      inject.expireAfter = -1;
    } else {
      inject.expireAfter -= 1;
    }
  }
  if (!currentSession(req)) {
    res.type("html").send(V.sessionExpiredFrame());
    return;
  }
  next();
});

app.get("/frame/nav", (req, res) => {
  res.type("html").send(V.navFrame(currentSession(req)!.operator));
});

app.get("/frame/search", (_req, res) => {
  res.type("html").send(V.searchFrame({ showInterstitial: takeInterstitial() }));
});

app.get("/frame/member", async (req, res) => {
  const memberNumber = String(req.query["txtMbrNo"] ?? "").trim();

  if (!memberNumber) {
    return res.type("html").send(V.searchFrame({ error: "Member number is required." }));
  }
  if (!/^\d{1,9}$/.test(memberNumber)) {
    return res.type("html").send(V.searchFrame({ error: "Member number must be numeric." }));
  }

  await maybeDelay();

  switch (behaviourFor(memberNumber)) {
    case "not_found":
      return res.type("html").send(V.notFoundFrame(memberNumber));
    case "permission_denied":
      return res.type("html").send(V.permissionDeniedFrame(memberNumber));
    case "app_error":
      return res.status(500).type("html").send(V.appErrorFrame());
    default: {
      const member = MEMBERS[memberNumber]!;
      return res.type("html").send(V.memberFrame(member, { showInterstitial: takeInterstitial(memberNumber) }));
    }
  }
});

app.get("/frame/subacct", (req, res) => {
  const memberNumber = String(req.query["mbr"] ?? "").trim();
  const member = MEMBERS[memberNumber];
  if (!member) return res.type("html").send(V.notFoundFrame(memberNumber));
  res.type("html").send(V.subAccountFormFrame(member));
});

app.post("/frame/subacct/review", (req, res) => {
  const memberNumber = String(req.body?.hdnMbrNo ?? "").trim();
  const product = String(req.body?.selProduct ?? "");
  const deposit = String(req.body?.txtDeposit ?? "").trim();
  const delivery = String(req.body?.selDelivery ?? "E");
  const member = MEMBERS[memberNumber];
  if (!member) return res.type("html").send(V.notFoundFrame(memberNumber));

  const prior = { selProduct: product, txtDeposit: deposit };
  if (!product) {
    return res.type("html").send(V.subAccountFormFrame(member, "Product is required.", prior));
  }
  if (!SUB_ACCOUNT_PRODUCTS.some((p) => p.code === product)) {
    return res.type("html").send(V.subAccountFormFrame(member, "Unrecognised product code.", prior));
  }
  const amount = Number(deposit.replace(/[$,]/g, ""));
  if (!deposit || Number.isNaN(amount)) {
    return res.type("html").send(V.subAccountFormFrame(member, "Initial deposit is required.", prior));
  }
  if (amount < 25) {
    return res.type("html").send(V.subAccountFormFrame(member, "Initial deposit must be at least 25.00.", prior));
  }
  res.type("html").send(V.subAccountReviewFrame(member, product, deposit, delivery));
});

app.post("/frame/subacct/commit", (req, res) => {
  const memberNumber = String(req.body?.hdnMbrNo ?? "").trim();
  const product = String(req.body?.hdnProduct ?? "");
  const member = MEMBERS[memberNumber];
  if (!member) return res.type("html").send(V.notFoundFrame(memberNumber));
  const newAccount = String(9000000000 + Math.floor(Math.random() * 999999));
  member.accounts.push({
    number: newAccount,
    kind: product.startsWith("MMK") ? "Money Market" : "Savings",
    status: "Open",
    balance: Number(String(req.body?.hdnDeposit ?? "0").replace(/[$,]/g, "")) || 0,
    openedOn: new Date().toLocaleDateString("en-US"),
  });
  res.type("html").send(V.subAccountConfirmFrame(member, newAccount, product));
});

app.get("/frame/reports", (_req, res) => res.type("html").send(V.stubFrame("Reports")));
app.get("/frame/admin", (_req, res) => res.type("html").send(V.stubFrame("Administration")));

// ---------------------------------------------------------------- injection surface

app.get("/dev/expire", (_req, res) => {
  sessions.clear();
  res.json({ ok: true, injected: "session_expired" });
});

app.get("/dev/interstitial", (req, res) => {
  inject.interstitialRemaining = Number(req.query["n"] ?? 1);
  res.json({ ok: true, injected: "interstitial", remaining: inject.interstitialRemaining });
});

app.get("/dev/slow", (req, res) => {
  inject.slowRemaining = Number(req.query["n"] ?? 1);
  inject.slowMs = Number(req.query["ms"] ?? 6000);
  res.json({ ok: true, injected: "slow", remaining: inject.slowRemaining, ms: inject.slowMs });
});

app.get("/dev/expire-after", (req, res) => {
  inject.expireAfter = Number(req.query["n"] ?? 2);
  res.json({ ok: true, injected: "expire_after", requests: inject.expireAfter });
});

app.get("/dev/reset", (_req, res) => {
  resetInjection();
  res.json({ ok: true, reset: true });
});

app.get("/dev/state", (_req, res) => {
  res.json({ app: APP_NAME, version: APP_VERSION, sessions: sessions.size, inject });
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} v${APP_VERSION} listening on http://localhost:${PORT}`);
  console.log(`  sign on with any operator ID and password "${PASSWORD}"`);
});

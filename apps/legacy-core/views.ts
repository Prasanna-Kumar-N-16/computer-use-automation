/**
 * Server-rendered views for the MeridianCore Servicing mock.
 *
 * These are intentionally hostile in the way real back-office banking software is:
 *   - a <frameset> shell, so every locator has to carry a frame path
 *   - table-based layout with label text in a sibling <td>, never a <label for=>
 *   - no ARIA, no data-testid, no semantic class names
 *   - form controls identified only by legacy name attributes (txtMbrNo, cmdSearch)
 *   - inline onclick handlers that navigate the sibling frame
 *
 * If the automation can drive this, it can drive a 1998 core banking screen.
 */

import { APP_NAME, APP_VERSION, type Account, type Member, SUB_ACCOUNT_PRODUCTS } from "./seed.js";

const CHROME = `<style>
  body { font-family: Verdana, Geneva, sans-serif; font-size: 11px; background: #d4d0c8; margin: 0; padding: 0; }
  table { border-collapse: collapse; font-size: 11px; }
  .pane { padding: 10px; }
  .hdr { background: #003366; color: #ffffff; padding: 5px 9px; font-weight: bold; font-size: 12px; }
  .grid td { border: 1px solid #808080; padding: 3px 7px; }
  .grid th { border: 1px solid #808080; padding: 3px 7px; background: #b8b4ac; text-align: left; }
  .lbl { background: #ece9d8; font-weight: bold; white-space: nowrap; }
  .err { color: #a00000; font-weight: bold; padding: 7px 0; }
  .note { color: #444444; padding: 6px 0; }
  input[type=text], input[type=password], select { font-family: Verdana; font-size: 11px; border: 1px solid #7f9db9; padding: 1px 2px; }
  input[type=submit], button { font-family: Verdana; font-size: 11px; padding: 1px 10px; }
  .ftr { color: #555555; font-size: 10px; padding: 12px 10px 4px 10px; }
  #sysmsg { position: fixed; left: 0; top: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.45); }
  #sysmsgbox { position: absolute; left: 50%; top: 90px; width: 380px; margin-left: -190px;
               background: #ece9d8; border: 2px outset #ffffff; padding: 0; }
</style>`;

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function footer(): string {
  return `<div class="ftr">${APP_NAME} &nbsp;v${APP_VERSION} &nbsp;|&nbsp; Meridian Community Credit Union &nbsp;|&nbsp; Confidential</div>`;
}

function page(title: string, body: string, extraHead = ""): string {
  return `<html><head><title>${esc(title)}</title>${CHROME}${extraHead}</head><body>${body}${footer()}</body></html>`;
}

/**
 * A blocking "system message" overlay. Real back-office apps throw these at you at
 * unpredictable moments (batch windows, broadcast notices). Replay has to dismiss it
 * as a recoverable condition rather than treat it as a dead end.
 */
export function interstitial(): string {
  return `<div id="sysmsg"><div id="sysmsgbox">
    <div class="hdr">System Message</div>
    <div class="pane">
      <p>Nightly batch posting is in progress. Account balances shown may be as of the
      prior business day.</p>
      <p align="right"><button onclick="document.getElementById('sysmsg').style.display='none'">Continue</button></p>
    </div>
  </div></div>`;
}

export function loginPage(error?: string): string {
  return page(
    `${APP_NAME} - Sign On`,
    `<div class="hdr">${APP_NAME} &nbsp;&#183;&nbsp; Sign On</div>
     <div class="pane">
       ${error ? `<div class="err">${esc(error)}</div>` : ""}
       <form method="post" action="/signon">
         <table>
           <tr><td class="lbl">Operator ID</td><td><input type="text" name="txtUser" size="24"></td></tr>
           <tr><td class="lbl">Password</td><td><input type="password" name="txtPass" size="24"></td></tr>
           <tr><td></td><td><input type="submit" name="cmdSignon" value="Sign On"></td></tr>
         </table>
       </form>
     </div>`
  );
}

/** The frameset shell. Everything the agent does happens inside the "main" frame. */
export function desktop(): string {
  return `<html><head><title>${APP_NAME}</title></head>
    <frameset rows="72,*" border="1" frameborder="1">
      <frame name="navFrame" src="/frame/nav" scrolling="no">
      <frame name="mainFrame" src="/frame/search">
    </frameset></html>`;
}

export function navFrame(operator: string): string {
  return page(
    "Navigation",
    `<div class="hdr">${APP_NAME}</div>
     <div class="pane">
       <table width="100%"><tr>
         <td>
           <a href="/frame/search" target="_self" onclick="parent.mainFrame.location='/frame/search';return false;">Member Inquiry</a>
           &nbsp;|&nbsp;
           <a href="#" onclick="parent.mainFrame.location='/frame/reports';return false;">Reports</a>
           &nbsp;|&nbsp;
           <a href="#" onclick="parent.mainFrame.location='/frame/admin';return false;">Administration</a>
         </td>
         <td align="right">Operator: <b>${esc(operator)}</b> &nbsp; <a href="/signoff" target="_top">Sign Off</a></td>
       </tr></table>
     </div>`
  );
}

export function sessionExpiredFrame(): string {
  return page(
    "Session Expired",
    `<div class="hdr">Session Expired</div>
     <div class="pane">
       <div class="err">Your session has timed out due to inactivity.</div>
       <p class="note">Sign on again to continue. Unsaved work has been discarded.</p>
       <p><a href="/" target="_top">Return to Sign On</a></p>
     </div>`
  );
}

export function searchFrame(opts: { error?: string; showInterstitial?: boolean } = {}): string {
  return page(
    "Member Inquiry",
    `<div class="hdr">Member Inquiry</div>
     <div class="pane">
       ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
       <form method="get" action="/frame/member">
         <table>
           <tr>
             <td class="lbl">Member Number</td>
             <td><input type="text" name="txtMbrNo" size="14" maxlength="9"></td>
             <td><input type="submit" name="cmdSearch" value="Search"></td>
           </tr>
           <tr><td class="lbl">Tax ID (last 4)</td><td><input type="text" name="txtTin4" size="6" maxlength="4"></td><td></td></tr>
         </table>
       </form>
       <p class="note">Enter a member number to retrieve the account relationship summary.</p>
     </div>
     ${opts.showInterstitial ? interstitial() : ""}`
  );
}

export function notFoundFrame(memberNumber: string): string {
  return page(
    "Member Inquiry",
    `<div class="hdr">Member Inquiry</div>
     <div class="pane">
       <div class="err">No member record found for ${esc(memberNumber)}.</div>
       <p class="note">Verify the member number and try again.</p>
       <p><a href="/frame/search">Return to Member Inquiry</a></p>
     </div>`
  );
}

export function permissionDeniedFrame(memberNumber: string): string {
  return page(
    "Access Restricted",
    `<div class="hdr">Access Restricted</div>
     <div class="pane">
       <div class="err">You are not authorized to view member ${esc(memberNumber)}.</div>
       <p class="note">This relationship is flagged RESTRICTED. Contact the Security Administrator
       to request entitlement.</p>
       <p><a href="/frame/search">Return to Member Inquiry</a></p>
     </div>`
  );
}

export function appErrorFrame(): string {
  return page(
    "Application Error",
    `<div class="hdr">Application Error</div>
     <div class="pane">
       <div class="err">SQLCODE -911: unexpected error retrieving relationship detail.</div>
       <p class="note">Reference MCS-7741. Report this incident to the Core Support desk.</p>
     </div>`
  );
}

function accountRow(a: Account): string {
  return `<tr>
    <td>${esc(a.number)}</td>
    <td>${esc(a.kind)}</td>
    <td>${esc(a.status)}</td>
    <td align="right">${money(a.balance)}</td>
    <td>${esc(a.openedOn)}</td>
  </tr>`;
}

export function memberFrame(m: Member, opts: { showInterstitial?: boolean } = {}): string {
  return page(
    `Member ${m.memberNumber}`,
    `<div class="hdr">Relationship Summary</div>
     <div class="pane">
       <table>
         <tr><td class="lbl">Member Number</td><td>${esc(m.memberNumber)}</td>
             <td class="lbl">Branch</td><td>${esc(m.branch)}</td></tr>
         <tr><td class="lbl">Member Name</td><td>${esc(m.name)}</td>
             <td class="lbl">Member Since</td><td>${esc(m.joinedOn)}</td></tr>
       </table>
       <br>
       <table class="grid" width="620">
         <tr><th>Account</th><th>Type</th><th>Status</th><th>Current Balance</th><th>Opened</th></tr>
         ${m.accounts.map(accountRow).join("\n")}
       </table>
       <br>
       <a href="/frame/subacct?mbr=${encodeURIComponent(m.memberNumber)}">Open New Sub-Account</a>
       &nbsp;|&nbsp;
       <a href="/frame/search">New Inquiry</a>
     </div>
     ${opts.showInterstitial ? interstitial() : ""}`
  );
}

export function subAccountFormFrame(m: Member, error?: string, prior: Record<string, string> = {}): string {
  const options = SUB_ACCOUNT_PRODUCTS.map(
    (p) => `<option value="${p.code}"${prior["selProduct"] === p.code ? " selected" : ""}>${esc(p.label)}</option>`
  ).join("");
  return page(
    "Open Sub-Account",
    `<div class="hdr">Open New Sub-Account</div>
     <div class="pane">
       ${error ? `<div class="err">${esc(error)}</div>` : ""}
       <form method="post" action="/frame/subacct/review">
         <input type="hidden" name="hdnMbrNo" value="${esc(m.memberNumber)}">
         <table>
           <tr><td class="lbl">Member</td><td>${esc(m.memberNumber)} &nbsp; ${esc(m.name)}</td></tr>
           <tr><td class="lbl">Product</td><td>
             <select name="selProduct"><option value="">-- select --</option>${options}</select></td></tr>
           <tr><td class="lbl">Initial Deposit</td><td>
             <input type="text" name="txtDeposit" size="12" value="${esc(prior["txtDeposit"] ?? "")}"> (minimum 25.00)</td></tr>
           <tr><td class="lbl">Statement Delivery</td><td>
             <select name="selDelivery">
               <option value="E">Electronic</option>
               <option value="P">Paper</option>
             </select></td></tr>
           <tr><td></td><td><input type="submit" name="cmdContinue" value="Continue"></td></tr>
         </table>
       </form>
     </div>`
  );
}

export function subAccountReviewFrame(m: Member, product: string, deposit: string, delivery: string): string {
  const label = SUB_ACCOUNT_PRODUCTS.find((p) => p.code === product)?.label ?? product;
  return page(
    "Review Sub-Account",
    `<div class="hdr">Review and Confirm</div>
     <div class="pane">
       <p class="note">Review the request below. Selecting <b>Post Account</b> creates the
       account on the core and cannot be reversed from this screen.</p>
       <table>
         <tr><td class="lbl">Member</td><td>${esc(m.memberNumber)} &nbsp; ${esc(m.name)}</td></tr>
         <tr><td class="lbl">Product</td><td>${esc(label)}</td></tr>
         <tr><td class="lbl">Initial Deposit</td><td>${esc(deposit)}</td></tr>
         <tr><td class="lbl">Statement Delivery</td><td>${delivery === "P" ? "Paper" : "Electronic"}</td></tr>
       </table>
       <br>
       <form method="post" action="/frame/subacct/commit">
         <input type="hidden" name="hdnMbrNo" value="${esc(m.memberNumber)}">
         <input type="hidden" name="hdnProduct" value="${esc(product)}">
         <input type="hidden" name="hdnDeposit" value="${esc(deposit)}">
         <input type="submit" name="cmdPost" value="Post Account">
         &nbsp;
         <input type="submit" name="cmdCancel" value="Cancel" formaction="/frame/search" formmethod="get">
       </form>
     </div>`
  );
}

export function subAccountConfirmFrame(m: Member, newAccount: string, product: string): string {
  const label = SUB_ACCOUNT_PRODUCTS.find((p) => p.code === product)?.label ?? product;
  return page(
    "Sub-Account Opened",
    `<div class="hdr">Confirmation</div>
     <div class="pane">
       <p><b>Account ${esc(newAccount)} has been opened.</b></p>
       <table>
         <tr><td class="lbl">Member</td><td>${esc(m.memberNumber)}</td></tr>
         <tr><td class="lbl">New Account</td><td>${esc(newAccount)}</td></tr>
         <tr><td class="lbl">Product</td><td>${esc(label)}</td></tr>
       </table>
       <p><a href="/frame/member?txtMbrNo=${encodeURIComponent(m.memberNumber)}">Return to Relationship Summary</a></p>
     </div>`
  );
}

export function stubFrame(title: string): string {
  return page(title, `<div class="hdr">${esc(title)}</div><div class="pane"><p class="note">Not implemented in this environment.</p></div>`);
}

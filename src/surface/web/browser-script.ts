/**
 * The script injected into every frame.
 *
 * This is where "what a human operator can see and do" gets turned into structured
 * data. It has to work on markup that predates every convention modern tooling relies
 * on: no ARIA, no labels wired to controls, no test IDs, layout carried entirely by
 * nested tables.
 *
 * Written as a plain string rather than a bundled module so it can be evaluated into
 * any frame, including ones created after page load, without a build step.
 */

export const BROWSER_SCRIPT = String.raw`
(function () {
  if (window.__cua) return "already";

  var els = [];

  /**
   * Identifies this document instance.
   *
   * Element references are indices into a per-document table, so an index from a
   * previous page would silently resolve to a *different* element after a navigation.
   * Stamping the document lets a stale reference be rejected outright instead.
   */
  var DOC = Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);

  function register(el) {
    var i = els.indexOf(el);
    if (i >= 0) return i;
    els.push(el);
    return els.length - 1;
  }

  function txt(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    return true;
  }

  /**
   * Role inference. Explicit role wins; otherwise fall back to the implicit role of
   * the tag, which is all these documents will ever give us.
   */
  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "hidden") return "hidden";
      if (t === "password") return "textbox";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "a") return el.getAttribute("href") ? "link" : "generic";
    if (tag === "table") return "table";
    if (tag === "img") return "image";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "generic";
  }

  /**
   * The legacy label problem.
   *
   * These screens put the field name in a sibling table cell and never wire it to the
   * control. A human reads the association off the layout; this reconstructs it, and
   * it is what makes the label_anchor locator strategy possible.
   */
  function labelTextFor(el) {
    // 1. A real label association, if we are lucky.
    if (el.id) {
      var lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (lbl) return txt(lbl);
    }
    var anc = el.closest ? el.closest("label") : null;
    if (anc) return txt(anc);

    // 2. The cell to the left in the same table row.
    var cell = el.closest ? el.closest("td,th") : null;
    if (cell) {
      var prev = cell.previousElementSibling;
      while (prev) {
        var t = txt(prev);
        if (t) return t;
        prev = prev.previousElementSibling;
      }
      // 3. Failing that, the first cell of the row.
      var row = cell.closest("tr");
      if (row && row.cells && row.cells.length && row.cells[0] !== cell) {
        var first = txt(row.cells[0]);
        if (first) return first;
      }
    }

    // 4. Whatever text immediately precedes the control.
    var p = el.previousSibling;
    while (p) {
      if (p.nodeType === 3) {
        var s = norm(p.nodeValue);
        if (s) return s;
      } else if (p.nodeType === 1) {
        var s2 = txt(p);
        if (s2) return s2;
      }
      p = p.previousSibling;
    }
    return "";
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /** Accessible name, with legacy fallbacks appended in decreasing reliability. */
  function nameOf(el) {
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return norm(aria);
    var lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) {
      var ref = document.getElementById(lb);
      if (ref) return txt(ref);
    }
    var tag = el.tagName.toLowerCase();
    var role = roleOf(el);

    if (role === "button") {
      if (tag === "input") return norm(el.getAttribute("value") || el.getAttribute("name") || "");
      return txt(el);
    }
    if (role === "link" || role === "heading") return txt(el);
    if (role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio") {
      var lt = labelTextFor(el);
      if (lt) return lt;
      return norm(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
    }
    if (tag === "img") return norm(el.getAttribute("alt") || "");
    return txt(el).slice(0, 120);
  }

  var INTERESTING =
    "a[href],button,input,select,textarea,[role],[onclick],h1,h2,h3,h4,h5,h6";

  function describeEl(el) {
    var r = el.getBoundingClientRect();
    var role = roleOf(el);
    var meta = {};
    var nm = el.getAttribute && el.getAttribute("name");
    if (nm) meta.controlName = nm;
    if (el.id) meta.controlId = el.id;
    meta.tag = el.tagName.toLowerCase();
    if (el.getAttribute && el.getAttribute("type")) meta.type = el.getAttribute("type");
    if (el.tagName.toLowerCase() === "a" && el.getAttribute("href")) meta.href = el.getAttribute("href");
    if (el.tagName.toLowerCase() === "select") {
      var opts = [];
      for (var oi = 0; oi < el.options.length; oi++) {
        opts.push(el.options[oi].value + "=" + norm(el.options[oi].text));
      }
      meta.options = opts.join("|");
    }
    return {
      ref: String(register(el)),
      role: role,
      name: nameOf(el),
      value: el.value !== undefined && el.type !== "password" ? String(el.value || "") : undefined,
      labelText: labelTextFor(el) || undefined,
      visible: isVisible(el),
      enabled: !el.disabled,
      bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      meta: meta,
    };
  }

  /**
   * Grid structure, exposed so the discovery model can declare an output as the
   * intersection of a column header and a matching row instead of pointing at a DOM
   * position it cannot see.
   */
  function grids(maxRows) {
    var out = [];
    var tables = document.querySelectorAll("table");
    for (var t = 0; t < tables.length; t++) {
      var headers = headerTexts(tables[t]).filter(Boolean);
      if (headers.length < 2) continue;
      var rows = [];
      var trs = tables[t].rows;
      for (var r = 0; r < trs.length && rows.length < (maxRows || 8); r++) {
        if (trs[r].querySelector("th")) continue;
        var cells = [];
        for (var c = 0; c < trs[r].cells.length; c++) cells.push(txt(trs[r].cells[c]));
        if (cells.join("").trim()) rows.push(cells);
      }
      if (rows.length) out.push({ headers: headers, rows: rows });
    }
    return out;
  }

  function snapshot() {
    var out = [];
    var nodes = document.querySelectorAll(INTERESTING);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (roleOf(el) === "hidden") continue;
      var d = describeEl(el);
      if (!d.visible) continue;
      out.push(d);
    }
    return {
      doc: DOC,
      url: location.href,
      title: document.title,
      elements: out,
      grids: grids(8),
      text: norm(document.body ? document.body.innerText : ""),
    };
  }

  // ------------------------------------------------------------------ resolution

  function allElements() {
    return Array.prototype.slice.call(document.querySelectorAll("*"));
  }

  function matchText(actual, expected, exact) {
    var a = norm(actual).toLowerCase();
    var b = norm(expected).toLowerCase();
    return exact ? a === b : a.indexOf(b) >= 0;
  }

  /** Returns the indices (into the handle table) of every element a strategy matches. */
  function resolve(strategy) {
    var found = [];
    var i, el, nodes;

    if (strategy.kind === "control_name") {
      nodes = document.getElementsByName(strategy.name);
      for (i = 0; i < nodes.length; i++) found.push(nodes[i]);
    } else if (strategy.kind === "control_id") {
      el = document.getElementById(strategy.id);
      if (el) found.push(el);
    } else if (strategy.kind === "attribute") {
      var sel = (strategy.tag || "*") + '[' + strategy.attr + '="' + cssEscape(strategy.value) + '"]';
      nodes = document.querySelectorAll(sel);
      for (i = 0; i < nodes.length; i++) found.push(nodes[i]);
    } else if (strategy.kind === "dom_path") {
      try {
        nodes = document.querySelectorAll(strategy.path);
        if (nodes.length > (strategy.ordinal || 0)) found.push(nodes[strategy.ordinal || 0]);
      } catch (e) { /* an invalid recorded path is a miss, not a crash */ }
    } else if (strategy.kind === "bounds") {
      var sx = window.innerWidth / (strategy.viewportWidth || window.innerWidth);
      var sy = window.innerHeight / (strategy.viewportHeight || window.innerHeight);
      var cx = (strategy.x + strategy.width / 2) * sx;
      var cy = (strategy.y + strategy.height / 2) * sy;
      el = document.elementFromPoint(cx, cy);
      if (el) found.push(el);
    } else if (strategy.kind === "role_name") {
      nodes = document.querySelectorAll(INTERESTING);
      for (i = 0; i < nodes.length; i++) {
        if (roleOf(nodes[i]) === strategy.role && matchText(nameOf(nodes[i]), strategy.name, strategy.exact)) {
          found.push(nodes[i]);
        }
      }
    } else if (strategy.kind === "text_anchor") {
      nodes = document.querySelectorAll(INTERESTING);
      for (i = 0; i < nodes.length; i++) {
        if (strategy.role && roleOf(nodes[i]) !== strategy.role) continue;
        var label = nameOf(nodes[i]) || txt(nodes[i]);
        if (matchText(label, strategy.text, strategy.exact)) found.push(nodes[i]);
      }
    } else if (strategy.kind === "label_anchor") {
      nodes = document.querySelectorAll("input,select,textarea,button,a[href]");
      for (i = 0; i < nodes.length; i++) {
        el = nodes[i];
        if (strategy.controlType) {
          var tag = el.tagName.toLowerCase();
          var ty = (el.getAttribute("type") || "").toLowerCase();
          if (strategy.controlType !== tag && strategy.controlType !== ty) continue;
        }
        if (matchText(labelTextFor(el), strategy.labelText, false)) found.push(el);
      }
    }

    var refs = [];
    for (i = 0; i < found.length; i++) {
      if (!found[i]) continue;
      if (roleOf(found[i]) === "hidden") continue;
      if (!isVisible(found[i])) continue;
      var idx = register(found[i]);
      if (refs.indexOf(idx) < 0) refs.push(idx);
    }
    return { doc: DOC, refs: refs };
  }

  // -------------------------------------------------------- locator construction

  /** Cheap structural path, used only as a late fallback. */
  function domPathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(tag + "#" + node.id); break; }
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
      }
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  }

  /**
   * Build every locator strategy that applies to an element, ordered
   * most-durable-first. Ordering is the whole robustness policy, expressed once here
   * and honoured by replay.
   */
  function describeLocator(ref) {
    var el = els[Number(ref)];
    if (!el) return null;
    var strategies = [];
    var role = roleOf(el);
    var name = nameOf(el);
    var ctlName = el.getAttribute && el.getAttribute("name");
    var lt = labelTextFor(el);
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();

    // 1. The server-contract name. Cannot change without changing the backend.
    if (ctlName) strategies.push({ kind: "control_name", name: ctlName });

    // 2. Role + accessible name. Survives layout change; breaks on relabelling.
    if (name) strategies.push({ kind: "role_name", role: role, name: name, exact: true });

    // 3. Relational anchor. Survives layout change and reordering.
    if (lt && (tag === "input" || tag === "select" || tag === "textarea")) {
      strategies.push({ kind: "label_anchor", labelText: lt, controlType: type || tag, relation: "same_row" });
    }

    // 4. The element's own visible text, for links and buttons.
    if ((role === "link" || role === "button") && (txt(el) || el.getAttribute("value"))) {
      strategies.push({ kind: "text_anchor", text: txt(el) || el.getAttribute("value"), role: role, exact: true });
    }

    // 5. An id, which in these apps is often generated and therefore untrustworthy.
    if (el.id) strategies.push({ kind: "control_id", id: el.id });

    // 6. Structure, then geometry. Last resorts, recorded so a degraded surface has something.
    strategies.push({ kind: "dom_path", path: domPathOf(el), ordinal: 0 });
    var r = el.getBoundingClientRect();
    strategies.push({
      kind: "bounds",
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    });

    var described = (lt ? lt + " " : "") + role + (name ? ' "' + name + '"' : "");
    return { description: norm(described), strategies: strategies };
  }

  // ------------------------------------------------------------------ extraction

  function headerTexts(table) {
    var out = [];
    var ths = table.querySelectorAll("th");
    if (ths.length) {
      for (var i = 0; i < ths.length; i++) out.push(txt(ths[i]));
      return out;
    }
    var first = table.rows && table.rows[0];
    if (first) for (var j = 0; j < first.cells.length; j++) out.push(txt(first.cells[j]));
    return out;
  }

  /**
   * Read a grid cell by the intersection of a row match and a column header.
   *
   * "The current balance of the savings account" is not a DOM position - it is a
   * relationship between two cells. Encoding it that way survives rows being added,
   * removed, or reordered, which a path never does.
   */
  function tableCell(spec) {
    var tables = document.querySelectorAll("table");
    for (var t = 0; t < tables.length; t++) {
      var headers = headerTexts(tables[t]);
      var ok = true;
      for (var h = 0; h < spec.tableHeaders.length; h++) {
        if (headers.indexOf(spec.tableHeaders[h]) < 0) { ok = false; break; }
      }
      if (!ok) continue;

      var matchCol = headers.indexOf(spec.rowMatchColumn);
      var valueCol = headers.indexOf(spec.valueColumn);
      if (matchCol < 0 || valueCol < 0) continue;

      var rows = tables[t].rows;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].cells;
        if (!cells || cells.length <= Math.max(matchCol, valueCol)) continue;
        if (rows[r].querySelector("th")) continue;
        var cellText = txt(cells[matchCol]);
        var hit = spec.rowMatchMode === "contains"
          ? cellText.toLowerCase().indexOf(String(spec.rowMatchValue).toLowerCase()) >= 0
          : cellText === spec.rowMatchValue;
        if (hit) return txt(cells[valueCol]);
      }
    }
    return null;
  }

  function elementText(ref) {
    var el = els[Number(ref)];
    if (!el) return null;
    if (el.value !== undefined && el.tagName.toLowerCase() !== "button") return String(el.value || "");
    return txt(el);
  }

  function pageText() {
    return norm(document.body ? document.body.innerText : "");
  }

  /**
   * Structural signature of the screen: the shape of the form controls and grid
   * headers, deliberately excluding any data. Two tenants running the same vendor
   * product with different branding should produce the same hash.
   */
  function structureSignature() {
    var parts = [];
    var ctl = document.querySelectorAll("input[name],select[name],textarea[name]");
    for (var i = 0; i < ctl.length; i++) {
      parts.push(ctl[i].tagName.toLowerCase() + ":" + ctl[i].getAttribute("name"));
    }
    var tables = document.querySelectorAll("table");
    for (var t = 0; t < tables.length; t++) {
      var h = headerTexts(tables[t]).filter(Boolean);
      if (h.length) parts.push("grid:" + h.join(","));
    }
    parts.sort();
    var s = parts.join("|");
    var hash = 5381;
    for (var c = 0; c < s.length; c++) hash = ((hash * 33) ^ s.charCodeAt(c)) >>> 0;
    return hash.toString(16);
  }

  function handleFor(ref) {
    return els[Number(ref)] || null;
  }

  window.__cua = {
    doc: DOC,
    snapshot: snapshot,
    grids: grids,
    resolve: resolve,
    describeLocator: describeLocator,
    tableCell: tableCell,
    elementText: elementText,
    pageText: pageText,
    structureSignature: structureSignature,
    handleFor: handleFor,
    reset: function () { els = []; },
  };
  return "installed";
})()
`;

/* Advosy Growth — Time Clock embeddable launcher
 * Drop-in floating clock-in widget for the Growth booking system.
 *
 * Usage (one line, near the end of <body>):
 *   <script src="https://YOUR-URL/embed.js"></script>
 *
 * Optional config via data-attributes on the script tag:
 *   data-user-id="REP_UUID"   pre-select the logged-in rep (they still confirm with PIN once)
 *   data-theme="light|dark"   match your app (default dark)
 *   data-position="right|left"
 *   data-label="Time Clock"   button text
 *
 * Or, to bind the rep dynamically after login:
 *   window.AdvosyTimeClock.setRep("REP_UUID")
 */
(function () {
  var me = document.currentScript;
  var base = me ? me.src.replace(/[^/]*$/, "") : "./";
  var cfg = {
    userId: me && me.getAttribute("data-user-id") || "",
    theme: me && me.getAttribute("data-theme") || "dark",
    position: me && me.getAttribute("data-position") || "right",
    label: me && me.getAttribute("data-label") || "Time Clock"
  };

  function widgetUrl() {
    var u = base + "widget.html?theme=" + encodeURIComponent(cfg.theme);
    if (cfg.userId) u += "&user_id=" + encodeURIComponent(cfg.userId);
    return u;
  }

  var side = cfg.position === "left" ? "left:20px;" : "right:20px;";

  // ---- styles ----
  var css = document.createElement("style");
  css.textContent =
    "#advosy-tc-btn{position:fixed;bottom:20px;" + side + "z-index:2147483000;display:flex;align-items:center;gap:9px;" +
    "background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;border:0;border-radius:999px;padding:12px 18px;" +
    "font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 26px rgba(79,70,229,.45);transition:.18s}" +
    "#advosy-tc-btn:hover{transform:translateY(-2px)}" +
    "#advosy-tc-btn .d{width:9px;height:9px;border-radius:50%;background:#fff;opacity:.95}" +
    "#advosy-tc-btn.on .d{background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:advtc 1.6s infinite}" +
    "@keyframes advtc{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}" +
    "#advosy-tc-panel{position:fixed;bottom:84px;" + side + "z-index:2147483000;width:360px;max-width:calc(100vw - 32px);" +
    "height:600px;max-height:calc(100vh - 110px);background:#0e121b;border:1px solid #293142;border-radius:18px;overflow:hidden;" +
    "box-shadow:0 18px 60px rgba(0,0,0,.5);transform:translateY(12px) scale(.98);opacity:0;pointer-events:none;transition:.2s;transform-origin:bottom right}" +
    "#advosy-tc-panel.open{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}" +
    "#advosy-tc-panel iframe{width:100%;height:100%;border:0;display:block}";
  document.head.appendChild(css);

  // ---- button ----
  var btn = document.createElement("button");
  btn.id = "advosy-tc-btn";
  btn.innerHTML = '<span class="d"></span><span>' + cfg.label + "</span>";

  // ---- panel (iframe loaded lazily on first open) ----
  var panel = document.createElement("div");
  panel.id = "advosy-tc-panel";
  var loaded = false, frame = null;

  function ensureFrame() {
    if (loaded) return;
    frame = document.createElement("iframe");
    frame.src = widgetUrl();
    frame.title = "Advosy Time Clock";
    frame.allow = "clipboard-write";
    panel.appendChild(frame);
    loaded = true;
    // if a rep was set dynamically, pass it once the frame is ready
    frame.addEventListener("load", function () {
      if (cfg.userId) try { frame.contentWindow.postMessage({ type: "advosy-rep", user_id: cfg.userId }, "*"); } catch (e) {}
    });
  }

  function toggle() {
    ensureFrame();
    panel.classList.toggle("open");
  }
  btn.addEventListener("click", toggle);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") panel.classList.remove("open"); });

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  // ---- public API ----
  window.AdvosyTimeClock = {
    open: function () { ensureFrame(); panel.classList.add("open"); },
    close: function () { panel.classList.remove("open"); },
    toggle: toggle,
    setRep: function (userId) {
      cfg.userId = userId || "";
      if (frame) try { frame.contentWindow.postMessage({ type: "advosy-rep", user_id: cfg.userId }, "*"); } catch (e) {}
    }
  };

  // reflect on-the-clock state on the button (optional, listens to widget pings)
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "advosy-clock-state") btn.classList.toggle("on", !!d.on);
  });
})();

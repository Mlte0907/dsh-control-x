/**
 * dsh-control-x 客户端 bundle（web）。
 *
 * 加载契约（官方样本 dsh-client-ui-sidebar-browser/lib/client.js、
 * dsh-client-ui-settings-plugins/lib/client.js 取证）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *   - factory 内 require 由宿主模块表解析（react 默认可用）
 *   - exports = { name, inject, apply(ctx) }
 * 挂载点（全部官方原生）：
 *   - 设置页：settings.plugins.tab slot（{id, order, label}, 组件第二参）
 *   - 面板：sidebar.right.pane.tab（{name, key}, 组件）+ .title slot
 * 面板数据源：本插件 webServer 路由 /api/x-control/*（SSE JPEG + 输入回传）。
 */
window.__ModuleLoader__.load({
  id: "dsh-control-x",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    var API = "/api/x-control";

    // ── 工具 ──
    function api(path, body) {
      return fetch(API + path, body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined).then(function (r) { return r.json(); });
    }
    function useFetchJson(path, deps) {
      var st = React.useState({ loading: true, data: null });
      React.useEffect(function () {
        var alive = true;
        api(path).then(function (d) { if (alive) st[1]({ loading: false, data: d }); })
          .catch(function (e) { if (alive) st[1]({ loading: false, data: null, error: String(e) }); });
        return function () { alive = false; };
      }, deps || []);
      return st;
    }

    // ── 设置页：config.json 覆盖项编辑 ──
    function SettingsTab() {
      var st = useFetchJson("/config");
      var form = React.useState(null);
      var cfg = form[0];
      var setCfg = form[1];
      React.useEffect(function () {
        if (st[0].data && !cfg) setCfg({
          headless: st[0].data.headless !== false,
          ttlMs: st[0].data.ttlMs ?? 30000,
          allowedApps: (st[0].data.allowedApps || []).join(", "),
          physicalIdleMs: st[0].data.physicalIdleMs ?? 3000,
        });
      }, [st[0].data]);
      if (st[0].loading) return h("p", null, "加载中…");
      if (!cfg) return h("p", null, "暂无覆盖配置（使用默认值）。");
      function field(label, key, type) {
        return h("label", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("span", { style: { width: 190 } }, label),
          h("input", {
            type: type || "text", value: String(cfg[key]),
            onChange: function (e) {
              var v = e.target.value;
              setCfg(Object.assign({}, cfg, key === "headless" ? {} : {}, (function () { var n = Object.assign({}, cfg); n[key] = type === "checkbox" ? e.target.checked : v; return n; })()));
            },
            style: { flex: 1 },
          }));
      }
      function save() {
        var apps = String(cfg.allowedApps).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        api("/config", {
          headless: cfg.headless === true || cfg.headless === "true",
          ttlMs: Number(cfg.ttlMs) || 30000,
          allowedApps: apps,
          physicalIdleMs: Number(cfg.physicalIdleMs) || 3000,
        }).then(function () { setCfg(Object.assign({}, cfg)); alert("已保存。浏览器与桌面工具在下次调用时读取新值。"); });
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 } },
        h("h3", { style: { margin: 0 } }, "control-x 配置覆盖"),
        h("p", { style: { color: "#888", margin: 0, fontSize: 13 } },
          "这些值覆盖 profile 配置，保存在 ~/.dsh/cache/dsh-control-x/config.json。"),
        h("label", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("input", { type: "checkbox", checked: cfg.headless === true || cfg.headless === "true",
            onChange: function (e) { setCfg(Object.assign({}, cfg, { headless: e.target.checked })); } }),
          "浏览器无头模式（保持勾选 = 不弹窗不打扰）"),
        field("观察快照 TTL（毫秒）", "ttlMs", "number"),
        field("物理输入空闲阈值（毫秒）", "physicalIdleMs", "number"),
        field("桌面白名单（逗号分隔，空=不限）", "allowedApps"),
        h("button", { onClick: save, style: { alignSelf: "flex-start", padding: "6px 18px" } }, "保存"));
    }

    // ── 右侧面板：无头浏览器实时画面 + 点击/滚动回传 ──
    function WatchPanel() {
      var tabsSt = useFetchJson("/tabs", [0]);
      var tabs = (tabsSt[0].data && tabsSt[0].data.tabs) || [];
      var tab = React.useState(tabs[0] ? tabs[0].id : null);
      var tabId = tab[0], setTabId = tab[1];
      var img = React.useRef(null);
      var size = React.useState({ w: 1280, h: 800 });
      var frameSize = size[0], setFrameSize = size[1];
      var note = React.useState("");
      var noteText = note[0], setNote = note[1];
      React.useEffect(function () {
        if (!tabId) return undefined;
        var es = new EventSource(API + "/stream?tab=" + encodeURIComponent(tabId));
        es.onmessage = function (e) {
          try {
            var f = JSON.parse(e.data);
            if (img.current) {
              img.current.src = "data:image/jpeg;base64," + f.data;
              setFrameSize({ w: f.w, h: f.h });
            }
          } catch {}
        };
        return function () { es.close(); };
      }, [tabId]);
      function relay(input) {
        api("/input", Object.assign({ tab: tabId }, input))
          .then(function (r) { setNote(r.ok ? "已回传" : "失败"); setTimeout(function () { setNote(""); }, 1200); })
          .catch(function () { setNote("回传失败"); });
      }
      function pos(e) {
        var r = e.target.getBoundingClientRect();
        return { x: Math.round((e.clientX - r.left) * (frameSize.w / r.width)), y: Math.round((e.clientY - r.top) * (frameSize.h / r.height)) };
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", boxSizing: "border-box" } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
          tabs.map(function (t) {
            return h("button", {
              key: t.id, onClick: function () { setTabId(t.id); },
              style: { padding: "2px 8px", fontSize: 12, fontWeight: t.id === tabId ? 700 : 400 },
              title: t.url,
            }, (t.title || t.url || t.id).slice(0, 24));
          }),
          tabs.length === 0 ? h("span", { style: { fontSize: 12, color: "#888" } },
            "暂无标签页：让 Agent 调用 x_browser_open 打开页面后，这里会实时显示。") : null),
        h("img", {
          ref: img, width: "100%",
          onClick: function (e) { var p = pos(e); relay({ type: "click", x: p.x, y: p.y }); },
          onWheel: function (e) { var p = pos(e); relay({ type: "scroll", x: p.x, y: p.y, deltaY: e.deltaY }); },
          style: { border: "1px solid #ccc", cursor: "crosshair", background: "#111", minHeight: 120 },
          alt: "浏览器实时画面",
        }),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 12 } },
          h("input", { id: "cx-key", placeholder: "按键，如 Enter / Control+a", style: { flex: 1 },
            onKeyDown: function (e) { if (e.key === "Enter") { relay({ type: "key", key: e.target.value }); e.target.value = ""; } } }),
          h("span", { style: { color: "#888" } }, noteText)),
        h("p", { style: { fontSize: 11, color: "#999", margin: 0 } },
          "点击画面 = 真实回传到无头浏览器（不影响你的桌面）。文本输入请让 Agent 用 x_browser_fill。"));
    }

    function WatchTitle() {
      return h("span", null, "control-x");
    }

    var inject = ["slots", "locale"];
    function apply(ctx) {
      // 设置页（Settings → Built-in plugins → control-x）
      ctx.effect(() => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
        name: "settings.plugins.tab",
        id: "control-x",
        order: 50,
        label: "control-x",
      }, SettingsTab)), "cx.settings");
      // 官方原生右侧面板（对齐 dsh-client-ui-sidebar-browser 的注册形状）
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: "control-x",
      }, WatchPanel)), "cx.panel");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
        name: "sidebar.right.pane.tab.title",
        key: "control-x",
      }, WatchTitle)), "cx.panel.title");
    }

    exports.name = "dsh-control-x";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

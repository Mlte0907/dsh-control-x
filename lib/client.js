/**
 * dsh-control-x 客户端 bundle（web）。
 *
 * 挂载点与形状全部来自本机已装真插件的实证（profiles/desktop/node_modules）：
 *   dsh-context/lib/client.js:13137-13168  settings.plugin.item + plugins.bundle.config
 *   dsh-context/lib/client.js:13112-13119  sidebar.footer.action
 *   dsh-context/lib/client.js:13121-13127  shell.overlay（点入口后弹出的面板）
 *   dsh-context/lib/client.js:8839-8900    配置行 = props.set(key, value)
 *   dsh-context/lib/client.js:13170-13174   module.exports = { name, inject, apply }
 *   头部形态：window.__ModuleLoader__.load({ id, factory })
 *
 * 配置由宿主 settingsScope 托管（props.useContextSettings 读、props.set 写），
 * 插件不自行持久化；这与 lib/index.js 的 Config schema 一一对应。
 */
window.__ModuleLoader__.load({
  id: "dsh-control-x",
  factory: (require) => {
    var module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var NS = "dsh-control-x";
    var API = "/api/x-control";

    function api(path, body) {
      return fetch(API + path, body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined).then(function (r) { return r.json(); });
    }

    // ── 复用宿主配置状态（settings.plugin.item 提供） ──
    function ConfigRows(props) {
      var st = react.useState(null);
      var state = st[0], setState = st[1];
      var setter = props.set;
      React_useContextSettings(props, setState);
      if (state === null || state.status === "unavailable") return null;
      var disabled = state.status !== "ready" || !state.writable;
      function row(label, key, type, options) {
        return h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "6px 0" } },
          h("span", { style: { width: 200, color: "var(--dsw-alias-label-primary)" } }, label),
          type === "bool"
            ? h("input", { type: "checkbox", disabled: disabled, checked: state[key] !== false,
                onChange: function (e) { setter && setter(key, e.target.checked); } })
            : type === "list"
              ? h("input", { type: "text", disabled: disabled, style: { flex: 1 },
                  value: (state[key] || []).join(", "),
                  onChange: function (e) {
                    setter && setter(key, e.target.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean));
                  } })
              : h("input", { type: "number", disabled: disabled, style: { width: 140 },
                  value: state[key] ?? 30000,
                  onChange: function (e) { setter && setter(key, Number(e.target.value) || 0); } }));
      }
      return h("div", { style: { display: "flex", flexDirection: "column" } },
        row("浏览器无头模式（关闭会弹出窗口）", "headless", "bool"),
        row("观察快照 TTL（毫秒）", "ttlMs", "number"),
        row("物理输入空闲阈值（毫秒）", "physicalIdleMs", "number"),
        row("桌面白名单（逗号分隔，空=不限）", "allowedApps", "list"));
    }

    // 兼容两种注入名（settings.plugin.item / plugins.bundle.config 提供的 props 形态一致）
    function React_useContextSettings(props, setState) {
      var getter = props.useContextSettings || props.useConfig;
      react.useEffect(function () {
        if (typeof getter !== "function") { setState({ status: "unavailable" }); return; }
        try { setState(getter(function (s) { return s; })); } catch { setState({ status: "unavailable" }); }
      }, [getter]);
    }

    // ── 设置页卡片：设置 → 插件 里的可折叠条目（照 dsh-context SettingsCard 形态） ──
    function SettingsCard(props) {
      var st = react.useState(false);
      var open = st[0], setOpen = st[1];
      return h("li", { className: "lc-settings-card" + (open ? " lc-settings-open" : ""), style: { listStyle: "none" } },
        h("button", {
          type: "button", className: "lc-settings-head",
          "aria-expanded": open,
          style: { display: "flex", gap: 8, width: "100%", padding: "8px 0", background: "none", border: "none", cursor: "pointer" },
          onClick: function () { setOpen(!open); },
        },
          h("span", { className: "lc-settings-name" }, "control-x"),
          h("span", { className: "lc-settings-desc", style: { color: "var(--dsw-alias-label-secondary)" } },
            "浏览器与桌面控制面")),
        open ? h("div", { className: "lc-settings-body" }, h(ConfigRows, props)) : null);
    }

    // ── 侧边栏面板：sidebar.footer.action 入口 + shell.overlay 面板 ──
    function Store() {
      var st = react.useState({ tabs: [], frame: null, w: 1280, h: 800, note: "" });
      var state = st[0], setState = st[1];
      var img = react.useRef(null);
      var esRef = react.useRef(null);
      var tabId = state.tabs.length ? state.tabs[0].id : null;

      react.useEffect(function () {
        var alive = true;
        api("/tabs").then(function (d) { if (alive) setState(function (s) { return Object.assign({}, s, { tabs: (d && d.tabs) || [] }); }); });
        return function () { alive = false; };
      }, []);

      react.useEffect(function () {
        if (!tabId) return undefined;
        var es = new EventSource(API + "/stream?tab=" + encodeURIComponent(tabId));
        esRef.current = es;
        es.onmessage = function (e) {
          try {
            var f = JSON.parse(e.data);
            if (img.current) img.current.src = "data:image/jpeg;base64," + f.data;
            setState(function (s) { return Object.assign({}, s, { w: f.w, h: f.h }); });
          } catch {}
        };
        return function () { es.close(); esRef.current = null; };
      }, [tabId]);

      function relay(input) {
        api("/input", Object.assign({ tab: tabId }, input)).then(function (r) {
          setState(function (s) { return Object.assign({}, s, { note: r.ok ? "已回传" : "失败" }); });
          setTimeout(function () { setState(function (s) { return Object.assign({}, s, { note: "" }); }); }, 1200);
        }).catch(function () { setState(function (s) { return Object.assign({}, s, { note: "回传失败" }); }); });
      }
      function pos(e) {
        var r = e.currentTarget.getBoundingClientRect();
        return {
          x: Math.round((e.clientX - r.left) * (state.w / r.width)),
          y: Math.round((e.clientY - r.top) * (state.h / r.height)),
        };
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: 8 } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
          state.tabs.map(function (t) {
            return h("button", { key: t.id, title: t.url, style: { padding: "2px 8px", fontSize: 12 } },
              (t.title || t.url || t.id).slice(0, 22));
          }),
          state.tabs.length === 0
            ? h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
                "暂无标签页：让 Agent 调用 x_browser_open 后这里会实时显示。")
            : null),
        h("img", {
          ref: img, width: "100%", alt: "浏览器实时画面",
          style: { border: "1px solid var(--dsw-alias-border, #ccc)", cursor: "crosshair", background: "#111", minHeight: 160 },
          onClick: function (e) { var p = pos(e); relay({ type: "click", x: p.x, y: p.y }); },
          onWheel: function (e) { var p = pos(e); relay({ type: "scroll", x: p.x, y: p.y, deltaY: e.deltaY }); },
        }),
        h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
          state.note || "点击画面=回传到无头浏览器（不影响你的桌面）；文本输入请让 Agent 用 x_browser_fill。"));
    }

    var store;
    // 保留引用占位：Store 为函数组件，渲染时由 React 调用，无需缓存
    void store;

    // 侧边栏入口按钮（照 dsh-context OverviewButton 形态：按钮 + 打开 overlay）
    function PanelEntry() {
      var st = react.useState(false);
      var open = st[0], setOpen = st[1];
      return h("button", {
        type: "button",
        title: "control-x 浏览器面板",
        style: { display: "flex", gap: 6, alignItems: "center", width: "100%", padding: "6px 8px", background: "none", border: "none", cursor: "pointer", color: "inherit" },
        onClick: function () { setOpen(!open); },
      }, h("span", null, "control-x 浏览器面板"), open ? h(Store, null) : null);
    }

    // inject 只声明必然存在的基础服务（对齐 dsh-context 的 ["slots","locale"]）。
    // settingsScope / sidebarRightTabs 等可选服务一律在 apply 内用 ctx.inject([...], cb)
    // 按需获取并判空——写进 inject 会让 cordis 一直等待不存在的服务，插件永不激活。
    var inject = ["slots", "locale"];

    function apply(ctx) {
      // 设置 → 插件：每个插件行内的可折叠配置卡片（settingsScope 是可选服务）
      ctx.inject(["settingsScope"], function (raw) {
        var binder = raw.settingsScope;
        if (binder === void 0) return;
        raw.slots.inject("settings.plugin.item", function () {
          return raw.slots.register({
            name: "settings.plugin.item",
            key: NS,
            locale: NS,
          }, function (props) { return h(SettingsCard, props); });
        });
      });
      // 侧边栏入口 + 面板容器（sidebarRightTabs 是可选服务）
      ctx.inject(["sidebarRightTabs"], function (raw) {
        var right = raw.sidebarRightTabs;
        if (right === void 0) return;
        raw.slots.inject("sidebar.footer.action", function () {
          return raw.slots.register({
            name: "sidebar.footer.action",
            id: "control-x",
            order: 20,
            locale: NS,
          }, function () { return h(PanelEntry, null); });
        });
        raw.slots.inject("shell.overlay", function () {
          return raw.slots.register({
            name: "shell.overlay",
            id: "control-x",
            order: 20,
            locale: NS,
          }, function () { return h(Store, null); });
        });
      });
    }

    module.exports = {
      name: "dsh-control-x",
      inject: inject,
      apply: apply,
    };
    return module.exports;
  },
});

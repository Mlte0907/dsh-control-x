/**
 * dsh-control-x 客户端 bundle（web）。
 *
 * 挂载点与形状来自本机真插件实证（dsh-context / dsh-teams-x 的 client 实现）：
 *   - sidebar.right.pane.tab(.title)  右侧栏 tab 正文与 chip 标题（按 tab 类型 id keyed）
 *     配 sidebarRightTabs.register({ id, kind, title, guide }) 声明 tab 类型与引导页入口
 *   - plugins.bundle.config           插件详情页配置卡片（按包名 keyed）
 *   - sidebar.footer.action + shell.overlay
 *     旧宿主回退路径（左侧栏底部入口 + 浮层面板），仅当右侧栏 tab 注册不可用时启用
 *
 * 关键约束（v0.2.1 血泪）：
 *   1. module.exports.inject 只声明必然存在的基础服务 ["slots","locale"]；
 *      可选服务一律 apply 内 ctx.inject([...], cb) 判空获取，否则 cordis 永远等待、boot 卡死。
 *   2. shell.overlay 的组件是常驻渲染的（不是"注册即打开"），必须自己按开关状态返回 null。
 *   3. 设置卡片的配置状态要在渲染期通过 props.useContextSettings(selector) 取，不能塞进 effect。
 *   4. sidebarRightTabs.register 的 id 全局唯一、重复注册直接 throw —— 包住 try/catch，
 *      注册失败退回旧路径，不能让宿主 registry 异常带倒整个插件。
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

    // ── 面板开关：侧边栏按钮与浮层组件共享的模块级状态 ──
    var panelOpen = false;
    var panelListeners = new Set();
    function setPanelOpen(next) {
      panelOpen = next;
      panelListeners.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略单个订阅者异常 */ } });
    }
    function usePanelOpen() {
      var pair = react.useState(panelOpen);
      var value = pair[0], setValue = pair[1];
      react.useEffect(function () {
        var fn = function () { setValue(panelOpen); };
        panelListeners.add(fn);
        return function () { panelListeners.delete(fn); };
      }, []);
      return value;
    }

    // ── 配置读写：绑定宿主 configForms（可选服务），供插件页配置卡片使用 ──
    // 实证：dsh-context/lib/client.js:13137-13168 + dsh-client-ui-plugin-manager README
    // 「Configuration pages」段（plugins.bundle.config 按包名 keyed，渲染在插件详情页）。
    function createSettingsStore() {
      var state = {
        status: "loading", writable: false,
        headless: true, ttlMs: 30000, physicalIdleMs: 3000, allowedApps: [],
      };
      var scope;
      var listeners = new Set();
      function publish(next) { state = next; listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略 */ } }); }
      function sync(bound) {
        var snap = bound.getSnapshot();
        var v = snap.value !== null && typeof snap.value === "object" ? snap.value : {};
        publish({
          status: snap.status === "ready" || snap.status === "unavailable" ? snap.status : "loading",
          writable: snap.writable === true,
          headless: v.headless !== false,
          ttlMs: typeof v.ttlMs === "number" ? v.ttlMs : 30000,
          physicalIdleMs: typeof v.physicalIdleMs === "number" ? v.physicalIdleMs : 3000,
          allowedApps: Array.isArray(v.allowedApps) ? v.allowedApps : [],
        });
      }
      return {
        store: {
          subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
          getSnapshot: function () { return state; },
        },
        attach: function (bound) {
          if (bound === void 0 || bound === null || typeof bound.getSnapshot !== "function") return function () {};
          scope = bound;
          sync(bound);
          return typeof bound.subscribe === "function" ? bound.subscribe(function () { sync(bound); }) : function () {};
        },
        set: function (field, value) {
          var patch = {}; patch[field] = value;
          publish(Object.assign({}, state, patch));
          if (scope === void 0 || typeof scope.set !== "function") return;
          scope.set(field, value).catch(function () { sync(scope); });
        },
      };
    }

    // ── 配置卡片（插件页 → dsh-control-x 详情页） ──
    function ConfigCard(props) {
      var state = typeof props.useCxSettings === "function" ? props.useCxSettings(function (s) { return s; }) : undefined;
      if (state === undefined || state === null) return null;
      if (state.status === "loading") {
        return h("p", { style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: 13, margin: "6px 0" } }, "加载配置…");
      }
      if (state.status === "unavailable") {
        return h("p", { style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: 13, margin: "6px 0" } },
          "配置暂不可用：可在 profile 的 cordis.patch.yml 中直接配置本插件。");
      }
      var setter = props.set;
      var disabled = state.writable !== true;
      function row(label, key, type) {
        var value = state[key];
        var input;
        if (type === "bool") {
          input = h("input", {
            type: "checkbox", disabled: disabled, checked: value !== false,
            onChange: function (e) { if (setter) setter(key, e.target.checked); },
          });
        } else if (type === "list") {
          input = h("input", {
            type: "text", disabled: disabled, style: { flex: 1, minWidth: 140 },
            defaultValue: (value || []).join(", "),
            onBlur: function (e) {
              if (setter) setter(key, String(e.target.value).split(",").map(function (s) { return s.trim(); }).filter(Boolean));
            },
          });
        } else {
          input = h("input", {
            type: "number", disabled: disabled, style: { width: 150 },
            defaultValue: value === undefined ? "" : String(value),
            onBlur: function (e) { if (setter) setter(key, Number(e.target.value) || 0); },
          });
        }
        return h("div", { key: key, style: { display: "flex", gap: 10, alignItems: "center", margin: "8px 0" } },
          h("span", { style: { width: 230, flexShrink: 0, fontSize: 13 } }, label), input);
      }
      return h("div", { style: { display: "flex", flexDirection: "column", padding: "4px 0", maxWidth: 640 } },
        h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, "control-x 配置"),
        row("浏览器无头模式（关闭会弹窗，破坏“不打扰”）", "headless", "bool"),
        row("观察快照 TTL（毫秒）", "ttlMs", "number"),
        row("物理输入空闲阈值（毫秒）", "physicalIdleMs", "number"),
        row("桌面白名单（逗号分隔，空=不限）", "allowedApps", "list"),
        disabled ? h("p", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", margin: 0 } }, "只读（宿主未提供写入通道）") : null);
    }

    // ── 面板主体：标签页 + 实时画面 + 输入回传 ──
    function PanelBody() {
      var pair = react.useState({ tabs: [], hasFrame: false, note: "" });
      var state = pair[0], setState = pair[1];
      var pairSel = react.useState(null);
      var selected = pairSel[0], setSelected = pairSel[1];
      var imgRef = react.useRef(null);
      var frameSize = react.useRef({ w: 1280, h: 800 });

      // 轮询标签页列表（面板打开期间每 3 秒）
      react.useEffect(function () {
        var alive = true;
        function load() {
          api("/tabs").then(function (d) {
            if (!alive) return;
            var tabs = (d && d.tabs) || [];
            setState(function (s) { return Object.assign({}, s, { tabs: tabs }); });
            setSelected(function (cur) {
              if (cur && tabs.some(function (t) { return t.id === cur; })) return cur;
              return tabs.length ? tabs[0].id : null;
            });
          }).catch(function () { /* 忽略轮询失败 */ });
        }
        load();
        var timer = setInterval(load, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      // 订阅选中标签页的 SSE 帧流
      react.useEffect(function () {
        if (!selected) return undefined;
        var es = new EventSource(API + "/stream?tab=" + encodeURIComponent(selected));
        es.onmessage = function (e) {
          try {
            var f = JSON.parse(e.data);
            frameSize.current = { w: f.w || 1280, h: f.h || 800 };
            if (imgRef.current) imgRef.current.src = "data:image/jpeg;base64," + f.data;
            setState(function (s) { return s.hasFrame ? s : Object.assign({}, s, { hasFrame: true }); });
          } catch (err) { /* 心跳等非帧消息 */ }
        };
        return function () { es.close(); };
      }, [selected]);

      function relay(input) {
        if (!selected) return;
        api("/input", Object.assign({ tab: selected }, input)).then(function (r) {
          setState(function (s) { return Object.assign({}, s, { note: r && r.ok ? "已回传" : "失败" }); });
          setTimeout(function () { setState(function (s) { return Object.assign({}, s, { note: "" }); }); }, 1200);
        }).catch(function () {
          setState(function (s) { return Object.assign({}, s, { note: "回传失败" }); });
          setTimeout(function () { setState(function (s) { return Object.assign({}, s, { note: "" }); }); }, 1200);
        });
      }
      function pos(e) {
        var rect = e.currentTarget.getBoundingClientRect();
        var f = frameSize.current;
        return {
          x: Math.round((e.clientX - rect.left) * (f.w / rect.width)),
          y: Math.round((e.clientY - rect.top) * (f.h / rect.height)),
        };
      }

      var tabBar = h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minHeight: 22 } },
        state.tabs.map(function (t) {
          var active = t.id === selected;
          return h("button", {
            key: t.id, title: t.url || t.id,
            onClick: function () { setSelected(t.id); },
            style: {
              padding: "2px 8px", fontSize: 12, cursor: "pointer", borderRadius: 4,
              border: "1px solid " + (active ? "var(--dsw-alias-brand-primary, #4a7dff)" : "transparent"),
              background: "none", color: "inherit", fontWeight: active ? 600 : 400,
            },
          }, (t.title || t.url || t.id).slice(0, 24));
        }));

      var main;
      if (!state.tabs.length) {
        main = h("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "center", height: 160, color: "var(--dsw-alias-label-secondary, #888)", fontSize: 13, textAlign: "center", padding: "0 16px", border: "1px dashed rgba(127,127,127,0.4)", borderRadius: 6 },
        }, "暂无标签页。让 Agent 调用 x_browser_open 打开页面后，这里会实时显示。");
      } else if (!state.hasFrame) {
        main = h("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "center", height: 160, color: "var(--dsw-alias-label-secondary, #888)", fontSize: 13, border: "1px dashed rgba(127,127,127,0.4)", borderRadius: 6 },
        }, "等待画面…");
      } else {
        main = h("img", {
          ref: imgRef, alt: "浏览器实时画面",
          style: { width: "100%", display: "block", cursor: "crosshair", borderRadius: 6, background: "#111" },
          onClick: function (e) { var p = pos(e); relay({ type: "click", x: p.x, y: p.y }); },
          onWheel: function (e) { var p = pos(e); relay({ type: "scroll", x: p.x, y: p.y, deltaY: e.deltaY }); },
        });
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: 10 } },
        tabBar,
        main,
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)" } },
          h("input", {
            placeholder: "按键，如 Enter / Control+a，回车发送",
            style: { flex: 1, padding: "4px 6px", borderRadius: 4, border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit" },
            onKeyDown: function (e) {
              if (e.key === "Enter" && e.target.value) { relay({ type: "key", key: e.target.value }); e.target.value = ""; }
            },
          }),
          h("span", null, state.note)),
        h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #777)" } },
          "点击画面 = 回传到无头浏览器（不影响你的桌面）。文本输入请让 Agent 用 x_browser_fill。"));
    }

    // ── 浮层面板（shell.overlay 常驻渲染，自行按开关显隐） ──
    function PanelOverlay() {
      var open = usePanelOpen();
      if (!open) return null;
      return h("div", {
        style: {
          position: "fixed", right: 18, bottom: 54, width: 430, maxHeight: "72vh",
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--dsw-alias-bg-elevated, #23242a)", color: "var(--dsw-alias-label-primary, #eee)",
          border: "1px solid rgba(127,127,127,0.35)", borderRadius: 10,
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)", zIndex: 9999,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid rgba(127,127,127,0.25)", fontSize: 13, fontWeight: 600 } },
          h("span", null, "control-x 浏览器"),
          h("button", {
            type: "button", title: "关闭",
            style: { background: "none", border: "none", cursor: "pointer", color: "inherit", fontSize: 16, lineHeight: 1, padding: 2 },
            onClick: function () { setPanelOpen(false); },
          }, "×")),
        h("div", { style: { overflowY: "auto" } }, h(PanelBody, null)));
    }

    // 侧边栏入口按钮：切换面板
    function PanelEntry() {
      var open = usePanelOpen();
      return h("button", {
        type: "button",
        title: "control-x 浏览器面板",
        style: {
          display: "flex", gap: 6, alignItems: "center", width: "100%", padding: "6px 8px",
          background: open ? "rgba(127,127,127,0.15)" : "none", border: "none", cursor: "pointer",
          color: "inherit", textAlign: "left", borderRadius: 6,
        },
        onClick: function () { setPanelOpen(!panelOpen); },
      }, h("span", null, "control-x 浏览器面板"));
    }

    // ── 右侧栏 tab：chip 标题（图标 + 文字）与引导页入口图标 ──
    function ControlXIcon(props) {
      var size = (props && props.size) || 16;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true",
        style: { flexShrink: 0, verticalAlign: "middle" },
      },
        h("rect", { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5, fill: "none", stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "M6 13.5h4M8 11.5v2", stroke: "currentColor", strokeWidth: 1.3, fill: "none", strokeLinecap: "round" }),
        h("path", { d: "M5.5 5.2l4.6 2.4-2.1.6-.7 2.1z", fill: "currentColor" }));
    }

    function TabTitle() {
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
        h(ControlXIcon, { size: 16 }),
        h("span", null, "control-x 浏览器"));
    }

    // inject 只声明必然存在的基础服务（对齐 dsh-context 的 ["slots","locale"]）。
    // settingsScope / sidebarRightTabs 等可选服务一律在 apply 内 ctx.inject([...], cb)
    // 按需获取并判空——写进 inject 会让 cordis 一直等待不存在的服务，插件永不激活。
    var inject = ["slots", "locale"];

    function apply(ctx) {
      var settings = createSettingsStore();
      // 插件页 → dsh-control-x 详情页的配置卡片（plugins.bundle.config，按包名 keyed）
      // 实证：dsh-context/lib/client.js:13152-13168；读写经宿主 configForms 服务。
      ctx.inject(["configForms"], function (raw) {
        var forms = raw.configForms;
        if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
        raw.effect(function () { return settings.attach(forms.get(NS)); }, "dsh-control-x: config forms");
        raw.effect(function () {
          return forms.whileServed([NS], function () {
            return raw.slots.inject("plugins.bundle.config", function () {
              return raw.slots.register({
                name: "plugins.bundle.config",
                key: NS,
                locale: NS,
                inject: function () {
                  return {
                    hooks: { cxSettings: settings.store },
                    set: function (field, value) { settings.set(field, value); },
                  };
                },
              }, function (props) { return h(ConfigCard, props); });
            });
          });
        }, "dsh-control-x: bundle config card");
      });
      // 右侧栏 tab（sidebarRightTabs 是可选服务；宿主无注册表时回退旧路径）
      // 形状实证：dsh-context/lib/client.js watchSidebarContextTab、
      // dsh-teams-x/lib/client/panel-hosts.js registerSidebarTab。
      // register({ id, kind, title, guide }) 返回 disposer；id 同时是
      // sidebar.right.pane.tab(.title) 两个 seat 的 key。同一 id 重复注册会 throw。
      ctx.inject(["sidebarRightTabs"], function (raw) {
        var tabs = raw.sidebarRightTabs;
        var registered = false;
        if (tabs !== void 0 && typeof tabs.register === "function") {
          try {
            tabs.register({
              id: NS,
              kind: NS,
              title: function () { return "control-x 浏览器"; },
              guide: [{
                id: NS,
                order: 40,
                title: function () { return "control-x 浏览器"; },
                description: function () { return "实时画面、标签页切换与输入回传"; },
                icon: ControlXIcon,
              }],
            });
            raw.slots.inject("sidebar.right.pane.tab", function () {
              return raw.slots.register({
                name: "sidebar.right.pane.tab",
                key: NS,
                locale: NS,
              }, function () { return h(PanelBody, null); });
            });
            raw.slots.inject("sidebar.right.pane.tab.title", function () {
              return raw.slots.register({
                name: "sidebar.right.pane.tab.title",
                key: NS,
              }, function () { return h(TabTitle, null); });
            });
            registered = true;
          } catch (e) {
            registered = false; // id 撞名等 registry 异常 → 退回旧路径
          }
        }
        if (registered || raw.slots === void 0) return;
        // 旧宿主回退：左侧栏底部入口 + 浮层面板
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
          }, function () { return h(PanelOverlay, null); });
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

/**
 * dsh-control-x 客户端 bundle（web）。
 *
 * 挂载点与形状来自本机真插件实证（dsh-context / dsh-teams-x 的 client 实现）：
 *   - sidebar.right.pane.tab(.title)  右侧栏 tab 正文与 chip 标题（按 tab 类型 id keyed）
 *     配 sidebarRightTabs.register({ id, kind, title, guide }) 声明 tab 类型与引导页入口
 *   - settings.section               设置页配置区「X-Agent操控」（先例：dsh-pangu / 官方 agent-presets）
 *   - conversation.input.overlay     会话输入框上的 X-Agent 按钮（先例：dsh-context 的 context-modal）
 *   - sidebar.footer.action + shell.overlay
 *     旧宿主回退路径（左侧栏底部入口 + 浮层面板），仅当右侧栏 tab 注册不可用时启用
 *
 * 关键约束（v0.2.1 血泪）：
 *   1. module.exports.inject 只声明必然存在的基础服务 ["slots","locale"]；
 *      可选服务一律 apply 内 ctx.inject([...], cb) 判空获取，否则 cordis 永远等待、boot 卡死。
 *   2. shell.overlay 的组件是常驻渲染的（不是"注册即打开"），必须自己按开关状态返回 null。
 *   3. 设置卡片的配置状态要在渲染期通过 props.useContextSettings(selector) 取，不能塞进 effect。
 *   4. sidebarRightTabs.register 的 id 全局唯一、重复注册直接 throw —— 宿主热重放
 *      （重跑 apply 不拆旧注册）时必现，按"已就位"容错；只有服务完全没有
 *      register 时才回退旧 footer/overlay，否则会双入口。
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
        browserEnabled: true, ignoreCertErrors: false,
        desktopEnabled: true, inputButtonEnabled: true,
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
          browserEnabled: v.browserEnabled !== false,
          ignoreCertErrors: v.ignoreCertErrors === true,
          desktopEnabled: v.desktopEnabled !== false,
          inputButtonEnabled: v.inputButtonEnabled !== false,
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

    // ── ZCode 风格设置控件：开关 / 卡片 / 行 / 分组标题 / 按钮 ──
    function Switch(props) {
      var checked = props.checked === true;
      var disabled = props.disabled === true;
      return h("button", {
        type: "button", role: "switch", "aria-checked": checked ? "true" : "false",
        disabled: disabled,
        onClick: function () { if (!disabled && props.onChange) props.onChange(!checked); },
        style: {
          position: "relative", width: 40, height: 22, borderRadius: 11, border: "none",
          cursor: disabled ? "default" : "pointer", padding: 0, flexShrink: 0,
          background: checked ? "var(--dsw-alias-brand-primary, #4a7dff)" : "rgba(127,127,127,0.35)",
          opacity: disabled ? 0.5 : 1, transition: "background .15s",
        },
      }, h("span", {
        style: {
          position: "absolute", top: 2, left: checked ? 20 : 2, width: 18, height: 18,
          borderRadius: "50%", background: "#fff", transition: "left .15s",
        },
      }));
    }

    function SettingCard(props) {
      return h("div", {
        style: {
          background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))",
          border: "1px solid rgba(127,127,127,0.18)", borderRadius: 10,
          overflow: "hidden", maxWidth: 720, marginBottom: 4,
        },
      }, props.children);
    }

    function SettingRow(props) {
      return h("div", {
        style: {
          display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: props.last === true ? "none" : "1px solid rgba(127,127,127,0.14)",
        },
      },
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { fontSize: 13, fontWeight: 600 } }, props.title),
          props.desc ? h("div", {
            style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", marginTop: 2, lineHeight: 1.5 },
          }, props.desc) : null),
        h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center", gap: 8 } }, props.control));
    }

    function GroupTitle(props) {
      return h("div", {
        style: {
          fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)",
          margin: "16px 0 6px", fontWeight: 600,
        },
      }, props.children);
    }

    function ActionButton(props) {
      var danger = props.danger === true;
      return h("button", {
        type: "button", disabled: props.disabled === true, onClick: props.onClick,
        style: {
          padding: "6px 14px", fontSize: 12, borderRadius: 6,
          cursor: props.disabled === true ? "default" : "pointer",
          border: danger ? "none" : "1px solid rgba(127,127,127,0.4)",
          background: danger ? "#e5484d" : "transparent",
          color: danger ? "#fff" : "inherit", fontWeight: 600,
        },
      }, props.children);
    }

    // ── 设置页配置区（settings.section「X-Agent操控」）──
    function ConfigCard(props) {
      var state = typeof props.useCxSettings === "function" ? props.useCxSettings(function (s) { return s; }) : undefined;
      var pairNote = react.useState("");
      var note = pairNote[0], setNote = pairNote[1];
      var pairArm = react.useState("");
      var arm = pairArm[0], setArm = pairArm[1];
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
      function toggle(key) {
        return function (next) { if (setter) setter(key, next); };
      }
      function row(key, type) {
        var value = state[key];
        var input;
        if (type === "bool") {
          input = h(Switch, {
            checked: value !== false, disabled: disabled,
            onChange: toggle(key),
          });
        } else if (type === "list") {
          input = h("input", {
            type: "text", disabled: disabled, style: { flex: 1, minWidth: 140, maxWidth: 260 },
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
        return input;
      }
      function flash(msg) {
        setNote(msg);
        setTimeout(function () { setNote(""); }, 3000);
      }
      function clearData(mode) {
        if (mode === "all" && arm !== "all") {
          setArm("all");
          setTimeout(function () { setArm(""); }, 4000);
          return;
        }
        setArm("");
        api("/clear-data", { mode: mode }).then(function (r) {
          if (r && r.error) flash("清除失败：" + r.error);
          else flash("已清除：" + ((r && r.cleared && r.cleared.length) ? r.cleared.join("、") : ((r && r.note) || "无数据")));
        }).catch(function () { flash("清除失败：服务不可达"); });
      }

      return h("div", { style: { display: "flex", flexDirection: "column", padding: "4px 0", maxWidth: 720 } },
        h("div", { style: { fontSize: 15, fontWeight: 700, marginBottom: 2 } }, "X-Agent 操控"),
        disabled ? h("p", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", margin: "0 0 4px" } }, "只读（宿主未提供写入通道）") : null,

        h(GroupTitle, null, "浏览器控制"),
        h(SettingCard, null,
          h(SettingRow, {
            title: "开启内置浏览器控制",
            desc: "开启后 Agent 可通过内置浏览器访问和操作网页；关闭后 x_browser_* 工具拒绝执行。",
            control: row("browserEnabled", "bool"),
          }),
          h(SettingRow, {
            title: "浏览器无头模式", last: true,
            desc: "关闭会弹出可见窗口，破坏“不打扰”原则。",
            control: row("headless", "bool"),
          })),

        h(GroupTitle, null, "安全"),
        h(SettingCard, null,
          h(SettingRow, {
            title: "忽略证书校验", last: true,
            desc: "开启后内置浏览器不再校验证书，仅影响内置浏览器。修改后需重启浏览器生效。",
            control: row("ignoreCertErrors", "bool"),
          })),

        h(GroupTitle, null, "浏览器数据"),
        h(SettingCard, null,
          h(SettingRow, {
            title: "清除内置浏览器缓存",
            desc: "清除 HTTP 缓存、Cache Storage 和 Service Worker，保留 Cookie 和本地站点数据。",
            control: h(ActionButton, { disabled: disabled, onClick: function () { clearData("cache"); } }, "清除缓存"),
          }),
          h(SettingRow, {
            title: "清除全部浏览器数据", last: true,
            desc: "删除内置浏览器中的 Cookie、站点数据和缓存。此操作不可撤销。",
            control: h(ActionButton, {
              danger: true, disabled: disabled,
              onClick: function () { clearData("all"); },
            }, arm === "all" ? "确认清除？" : "清除全部"),
          })),

        h(GroupTitle, null, "电脑控制"),
        h(SettingCard, null,
          h(SettingRow, {
            title: "启用电脑控制",
            desc: "开启后启用桌面控制工具（观察、点击、输入）；关闭后 x_desktop_* 拒绝执行。",
            control: row("desktopEnabled", "bool"),
          }),
          h(SettingRow, {
            title: "在输入框显示 X-Agent 按钮", last: true,
            desc: "关闭后输入框不再显示 X-Agent 按钮（点击打开右侧浏览器面板）。",
            control: row("inputButtonEnabled", "bool"),
          })),

        h(GroupTitle, null, "观察与桌面"),
        h(SettingCard, null,
          h(SettingRow, {
            title: "观察快照 TTL（毫秒）",
            desc: "过期后动作拒绝并要求重新观察。",
            control: row("ttlMs", "number"),
          }),
          h(SettingRow, {
            title: "物理输入空闲阈值（毫秒）",
            desc: "用户活跃时拒绝显式打扰路径。0 = 关闭检测。",
            control: row("physicalIdleMs", "number"),
          }),
          h(SettingRow, {
            title: "桌面白名单（逗号分隔，空=不限）", last: true,
            desc: "限制可操控的应用名。",
            control: row("allowedApps", "list"),
          })),

        note ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", marginTop: 8 } }, note) : null);
    }

    // ── 小图标按钮（工具栏 ← → ↻ ↗）──
    function ToolButton(props) {
      return h("button", {
        type: "button", title: props.title, disabled: props.disabled === true, onClick: props.onClick,
        style: {
          width: 26, height: 26, borderRadius: 5, border: "1px solid rgba(127,127,127,0.3)",
          background: "none", color: "inherit", fontSize: 13, lineHeight: 1, padding: 0,
          cursor: props.disabled === true ? "default" : "pointer",
          opacity: props.disabled === true ? 0.4 : 1, flexShrink: 0,
        },
      }, props.children);
    }

    function GlobeIcon(props) {
      var size = (props && props.size) || 40;
      return h("svg", { width: size, height: size, viewBox: "0 0 48 48", "aria-hidden": "true", opacity: 0.75 },
        h("circle", { cx: 24, cy: 24, r: 18, fill: "none", stroke: "currentColor", strokeWidth: 2.5 }),
        h("ellipse", { cx: 24, cy: 24, rx: 8, ry: 18, fill: "none", stroke: "currentColor", strokeWidth: 2 }),
        h("path", { d: "M6 24h36M9 15h30M9 33h30", stroke: "currentColor", strokeWidth: 2, fill: "none" }));
    }

    /** 地址栏归一：无 scheme 默认 https://；空串返回 null。 */
    function normalizeUrl(raw) {
      var u = String(raw || "").trim();
      if (!u) return null;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
      return u;
    }

    // ── 面板主体：标签页 + 工具栏 + 实时画面 + 输入回传 ──
    function PanelBody(props) {
      var settingsState = typeof props.useCxSettings === "function"
        ? props.useCxSettings(function (s) { return s; })
        : undefined;
      var pair = react.useState({ tabs: [], hasFrame: false, note: "" });
      var state = pair[0], setState = pair[1];
      var pairSel = react.useState(null);
      var selected = pairSel[0], setSelected = pairSel[1];
      var pairUrl = react.useState("");
      var urlDraft = pairUrl[0], setUrlDraft = pairUrl[1];
      var imgRef = react.useRef(null);
      var frameSize = react.useRef({ w: 1280, h: 800 });
      var urlFocused = react.useRef(false);

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

      // 地址栏跟随选中标签页（输入中不打断）
      react.useEffect(function () {
        if (urlFocused.current) return;
        var cur = null;
        for (var i = 0; i < state.tabs.length; i++) {
          if (state.tabs[i].id === selected) { cur = state.tabs[i]; break; }
        }
        setUrlDraft(cur && cur.url ? cur.url : "");
      }, [selected, state.tabs]);

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

      function flashNote(msg) {
        setState(function (s) { return Object.assign({}, s, { note: msg }); });
        if (!msg) return;
        setTimeout(function () {
          setState(function (s) { return s.note === msg ? Object.assign({}, s, { note: "" }) : s; });
        }, 2500);
      }
      function expect(r) {
        if (r && r.error) throw new Error(r.error);
        return r;
      }

      // 工具栏导航：← → ↻
      function nav(action) {
        if (!selected) { flashNote("暂无标签页"); return; }
        api("/nav", { tab: selected, action: action }).then(function (r) {
          expect(r);
          if (r && r.tab) setUrlDraft(r.tab.url || "");
        }).catch(function (e) {
          flashNote((action === "back" ? "后退" : action === "forward" ? "前进" : "刷新") + "失败：" + ((e && e.message) || e));
        });
      }

      // 地址栏回车导航
      function go() {
        var target = normalizeUrl(urlDraft);
        if (!target) return;
        api("/navigate", selected ? { tab: selected, url: target } : { url: target }).then(function (r) {
          expect(r);
          if (r && r.tab) {
            setSelected(r.tab.id);
            setUrlDraft(r.tab.url || target);
          }
        }).catch(function (e) { flashNote("导航失败：" + ((e && e.message) || e)); });
      }

      // 在系统默认浏览器中打开
      function openExternal() {
        if (!selected) { flashNote("暂无标签页"); return; }
        api("/open-external", { tab: selected }).then(function (r) {
          expect(r);
          flashNote("已在默认浏览器打开");
        }).catch(function (e) { flashNote("打开失败：" + ((e && e.message) || e)); });
      }

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

      // 设置页关闭了浏览器控制 → 只给指引
      if (settingsState && settingsState.browserEnabled === false) {
        return h("div", { style: { padding: 16, fontSize: 13, color: "var(--dsw-alias-label-secondary, #888)", lineHeight: 1.7 } },
          "浏览器控制已关闭。到 设置 → X-Agent操控 开启「开启内置浏览器控制」后再使用。");
      }

      var toolbar = h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h(ToolButton, { title: "后退", disabled: !selected, onClick: function () { nav("back"); } }, "←"),
        h(ToolButton, { title: "前进", disabled: !selected, onClick: function () { nav("forward"); } }, "→"),
        h(ToolButton, { title: "刷新", disabled: !selected, onClick: function () { nav("reload"); } }, "↻"),
        h("input", {
          value: urlDraft,
          placeholder: "输入网址后回车",
          onFocus: function () { urlFocused.current = true; },
          onBlur: function () { urlFocused.current = false; },
          onChange: function (e) { setUrlDraft(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter") go(); },
          style: {
            flex: 1, minWidth: 0, padding: "5px 8px", fontSize: 12, borderRadius: 5,
            border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit",
          },
        }),
        h(ToolButton, { title: "在默认浏览器中打开", disabled: !selected, onClick: openExternal }, "↗"));

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
          style: {
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 6, minHeight: 200, padding: 20, textAlign: "center",
            color: "var(--dsw-alias-label-secondary, #888)",
            border: "1px dashed rgba(127,127,127,0.4)", borderRadius: 6,
          },
        },
          h(GlobeIcon, { size: 40 }),
          h("div", { style: { fontSize: 14, fontWeight: 600 } }, "浏览器"),
          h("div", { style: { fontSize: 12 } }, "粘贴或输入 URL 以打开网页。"),
          h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #777)" } },
            "也可以让 Agent 调用 x_browser_open。"));
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
        toolbar,
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
          h("span", null, "X-Agent浏览器"),
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
        title: "X-Agent浏览器面板",
        style: {
          display: "flex", gap: 6, alignItems: "center", width: "100%", padding: "6px 8px",
          background: open ? "rgba(127,127,127,0.15)" : "none", border: "none", cursor: "pointer",
          color: "inherit", textAlign: "left", borderRadius: 6,
        },
        onClick: function () { setPanelOpen(!panelOpen); },
      }, h("span", null, "X-Agent浏览器面板"));
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
        h("span", null, "X-Agent浏览器"));
    }

    // ── 会话输入框上的 X-Agent 按钮（conversation.input.overlay）──
    function InputActionButton(props) {
      var state = typeof props.useCxSettings === "function"
        ? props.useCxSettings(function (s) { return s; })
        : undefined;
      if (state && state.inputButtonEnabled === false) return null;
      return h("button", {
        type: "button", title: "打开 X-Agent 浏览器面板",
        style: {
          display: "flex", gap: 6, alignItems: "center", padding: "6px 10px",
          fontSize: 12, borderRadius: 18, border: "1px solid rgba(127,127,127,0.4)",
          background: "none", cursor: "pointer", color: "inherit",
        },
        onClick: function () { if (!openRightTab()) setPanelOpen(!panelOpen); },
      }, h(ControlXIcon, { size: 14 }), "X-Agent");
    }

    // ── 宿主根上下文（apply 时写入）：模块级组件用它打开右侧栏 tab ──
    var rootCtx = null;
    function openRightTab() {
      try {
        var face = rootCtx && typeof rootCtx.get === "function" ? rootCtx.get("sidebarRight") : undefined;
        if (face && typeof face.openTab === "function") { face.openTab(NS); return true; }
      } catch (e) { /* 服务不存在 */ }
      return false;
    }

    // inject 只声明必然存在的基础服务（对齐 dsh-context 的 ["slots","locale"]）。
    // settingsScope / sidebarRightTabs 等可选服务一律在 apply 内 ctx.inject([...], cb)
    // 按需获取并判空——写进 inject 会让 cordis 一直等待不存在的服务，插件永不激活。
    var inject = ["slots", "locale"];

    function apply(ctx) {
      rootCtx = ctx;
      var settings = createSettingsStore();

      // 配置页 → 设置页 section（settings.section）
      // 先例：社区 dsh-pangu（id pangu-settings, order 40, label 简体中文）、
      // 官方 agent-presets（带 inject face）均走此 slot；按立项决策从
      // 插件详情页（plugins.bundle.config）迁到设置页。
      // whileServed([NS]) = 宿主供给本插件配置服务期间常驻，随停用撤回。
      ctx.inject(["configForms"], function (raw) {
        var forms = raw.configForms;
        if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
        raw.effect(function () { return settings.attach(forms.get(NS)); }, "dsh-control-x: config forms");
        raw.effect(function () {
          return forms.whileServed([NS], function () {
            return raw.slots.inject("settings.section", function () {
              return raw.slots.register({
                name: "settings.section",
                id: "control-x",
                order: 50,
                label: function () { return "X-Agent操控"; },
                inject: function () {
                  return {
                    hooks: { cxSettings: settings.store },
                    set: function (field, value) { settings.set(field, value); },
                  };
                },
              }, function (props) { return h(ConfigCard, props); });
            });
          });
        }, "dsh-control-x: settings section");
        // 输入框 X-Agent 按钮（显隐由 inputButtonEnabled 实时控制）
        raw.effect(function () {
          return raw.slots.inject("conversation.input.overlay", function () {
            return raw.slots.register({
              name: "conversation.input.overlay",
              id: "control-x",
              order: 20,
              locale: NS,
              inject: function () {
                return { hooks: { cxSettings: settings.store } };
              },
            }, function (props) { return h(InputActionButton, props); });
          });
        }, "dsh-control-x: input overlay button");
      });
      // 右侧栏 tab（sidebarRightTabs 是可选服务；宿主无注册表时回退旧路径）
      // 形状实证：dsh-context/lib/client.js watchSidebarContextTab、
      // dsh-teams-x/lib/client/panel-hosts.js registerSidebarTab。
      // register({ id, kind, title, guide }) 返回 disposer；id 同时是
      // sidebar.right.pane.tab(.title) 两个 seat 的 key。
      // 热重放教训：宿主重跑 apply 时若上一实例的注册还在，同一 id 会 throw ——
      // 这是"已经注册过"，必须容错继续补 seat，绝不能落进旧 footer/overlay
      // 回退（否则左侧入口+浮层与右侧 tab 双双出现）。
      ctx.inject(["sidebarRightTabs"], function (raw) {
        var tabs = raw.sidebarRightTabs;
        if (tabs === void 0 || raw.slots === void 0) return;
        if (typeof tabs.register !== "function") {
          // 无注册表的极老宿主：旧路径（左侧栏底部入口 + 浮层面板）
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
          return;
        }
        try {
          tabs.register({
            id: NS,
            kind: NS,
            title: function () { return "X-Agent浏览器"; },
            guide: [{
              id: NS,
              order: 40,
              title: function () { return "X-Agent浏览器"; },
              description: function () { return "内置浏览器实时画面、地址栏导航与输入回传"; },
              icon: ControlXIcon,
            }],
          });
        } catch (e) { /* 重复注册（热重放）= 已就位，继续补 seat */ }
        try {
          raw.slots.inject("sidebar.right.pane.tab", function () {
            return raw.slots.register({
              name: "sidebar.right.pane.tab",
              key: NS,
              locale: NS,
              // 面板读设置（browserEnabled 关闭横幅、输入按钮显隐共用一个 store）
              inject: function () {
                return { hooks: { cxSettings: settings.store } };
              },
            }, function (props) { return h(PanelBody, props); });
          });
        } catch (e) { /* 同 key 已存在：沿用既有注册 */ }
        try {
          raw.slots.inject("sidebar.right.pane.tab.title", function () {
            return raw.slots.register({
              name: "sidebar.right.pane.tab.title",
              key: NS,
            }, function () { return h(TabTitle, null); });
          });
        } catch (e) { /* 同 key 已存在：沿用既有注册 */ }
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

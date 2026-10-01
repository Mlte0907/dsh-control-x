/**
 * dsh-control-x 客户端 bundle（web）。
 *
 * 挂载点与形状来自本机真插件实证（dsh-context / dsh-teams-x 的 client 实现）：
 *   - sidebar.right.pane.tab(.title)  右侧栏 tab 正文与 chip 标题（按 tab 类型 id keyed）
 *     配 sidebarRightTabs.register({ id, kind, title, guide }) 声明 tab 类型与引导页入口
 *   - settings.section               设置页配置区「X-Agent操控」（先例：dsh-pangu / 官方 agent-presets）
 *   - conversation.input.left        会话输入框工具行左侧的 X-Agent 按钮
 *                                    （"Compact controls at the left of the composer tool row"；
 *                                     注意别用 conversation.input.overlay——那是 composer 卡内的浮层锚点，
 *                                     属于斜杠菜单/命令弹窗，行内按钮会被悬在占位文字上）
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
        headless: true, ttlMs: 30000, physicalIdleMs: 3000, allowedApps: [], browserIdleMs: 300000,
        browserEnabled: true, ignoreCertErrors: false,
        desktopEnabled: true, inputButtonEnabled: true, desktopBanner: true, bannerIdleExitMs: 120000,
        trustPhysicalInput: false, updateMirror: "",
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
          browserIdleMs: typeof v.browserIdleMs === "number" ? v.browserIdleMs : 300000,
          physicalIdleMs: typeof v.physicalIdleMs === "number" ? v.physicalIdleMs : 3000,
          allowedApps: Array.isArray(v.allowedApps) ? v.allowedApps : [],
          browserEnabled: v.browserEnabled !== false,
          ignoreCertErrors: v.ignoreCertErrors === true,
          desktopEnabled: v.desktopEnabled !== false,
          inputButtonEnabled: v.inputButtonEnabled !== false,
          desktopBanner: v.desktopBanner !== false,
          bannerIdleExitMs: typeof v.bannerIdleExitMs === "number" ? v.bannerIdleExitMs : 120000,
          trustPhysicalInput: v.trustPhysicalInput === true,
          updateMirror: typeof v.updateMirror === "string" ? v.updateMirror : "",
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
          // 品牌色写死：--dsw-alias-brand-primary 在本机主题解析成白色，
          // 选中态会变成"白轨道+白滑块"的隐形团（设置页实测）。
          background: checked ? "#4a7dff" : "rgba(127,127,127,0.35)",
          opacity: disabled ? 0.5 : 1, transition: "background .15s",
        },
      }, h("span", {
        style: {
          position: "absolute", top: 2, left: checked ? 20 : 2, width: 18, height: 18,
          borderRadius: "50%", background: "#fff", transition: "left .15s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
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
      var primary = props.primary === true;
      return h("button", {
        type: "button", disabled: props.disabled === true, onClick: props.onClick,
        style: {
          padding: "6px 14px", fontSize: 12, borderRadius: 6,
          cursor: props.disabled === true ? "default" : "pointer",
          border: danger || primary ? "none" : "1px solid rgba(127,127,127,0.4)",
          background: danger ? "#e5484d" : (primary ? "#4a7dff" : "transparent"),
          color: danger || primary ? "#fff" : "inherit", fontWeight: 600,
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
            title: "浏览器无头模式",
            desc: "关闭会弹出可见窗口，破坏“不打扰”原则。",
            control: row("headless", "bool"),
          }),
          h(SettingRow, {
            title: "浏览器空闲关闭（毫秒）", last: true,
            desc: "Agent 不再操作浏览器后，等这么久就把内置浏览器整个关掉（省内存）。0 = 永不自动关。",
            control: row("browserIdleMs", "number"),
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
            title: "桌面置顶横幅",
            desc: "Agent 操控时在屏幕顶部弹出原生置顶提示，任何应用之上都能看见（不抢焦点、可穿透点击）。" +
              "按需拉起：第一次操控才启动进程。关闭后只剩 DSH 窗口内的横幅。",
            control: row("desktopBanner", "bool"),
          }),
          h(SettingRow, {
            title: "横幅空闲退出（毫秒）",
            desc: "停止操控后多久退出横幅进程，下次操控再拉起；0 = 用过一次就不再退出。",
            control: row("bannerIdleExitMs", "number"),
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
            title: "全权操控（免逐次审批）",
            desc: "开启后 Agent 的物理键鼠（点击/输入/按键）不再每次问你，只在需要删除、支付、注销时仍会请求审批。空闲检测仍然有效。",
            control: row("trustPhysicalInput", "bool"),
          }),
          h(SettingRow, {
            title: "桌面白名单（逗号分隔，空=不限）", last: true,
            desc: "限制可操控的应用名。",
            control: row("allowedApps", "list"),
          })),

        h(GroupTitle, null, "视觉模型"),
        h(SettingCard, null,
          h(VisionModelSelect, {
            value: state.visionModel,
            onChange: function (next) { set("visionModel", next); },
          })),

        h(GroupTitle, null, "版本与更新"),
        h(UpdatePanel, {
          updateMirror: state.updateMirror,
          setMirror: function (next) { set("updateMirror", next); },
        }),

        note ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", marginTop: 8 } }, note) : null);
    }

    // ── 视觉模型选择：选项来自宿主已添加且声明支持图片的模型 ──
    //
    // 数据源是服务端 GET /vision-models（宿主 ctx.llm.listProviders + listModels，
    // 按 inputModalities 含 image 过滤）。取不到就明说"不可用"，不给一个永远空着的
    // 下拉装正常——那是本次事故同款的假绿。
    function VisionModelSelect(props) {
      var st = react.useState({ available: null, models: [], error: "" });
      var data = st[0], setData = st[1];
      react.useEffect(function () {
        var alive = true;
        api("/vision-models").then(function (r) {
          if (!alive) return;
          setData({ available: r.available !== false, models: Array.isArray(r.models) ? r.models : [], error: "" });
        }).catch(function (e) {
          if (!alive) return;
          setData({ available: false, models: [], error: String(e && e.message || e).slice(0, 80) });
        });
        return function () { alive = false; };
      }, []);

      var value = typeof props.value === "string" ? props.value : "";
      var style = {
        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))",
        color: "var(--dsw-alias-label-primary, #eee)",
        border: "1px solid rgba(127,127,127,0.25)", borderRadius: 8,
        padding: "6px 10px", fontSize: 13, minWidth: 220, maxWidth: "100%",
      };
      var body;
      if (data.available === false) {
        body = h("div", {
          style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", lineHeight: 1.6 },
        }, "宿主未提供模型列表服务（ctx.llm 不可用），无法列出视觉模型。" + (data.error ? "（" + data.error + "）" : ""));
      } else {
        var options = [
          h("option", { key: "", value: "" }, "系统推荐"),
          h("option", { key: "random", value: "random" }, "随机（每次重新挑）"),
        ].concat(data.models.map(function (m) {
          return h("option", { key: m.provider + "/" + m.model, value: m.provider + "/" + m.model },
            m.name + " · " + m.provider);
        }));
        body = h("select", {
          style: style, value: value, onChange: function (e) { props.onChange(e.target.value); },
        }, options);
        if (data.models.length === 0) {
          body = h("div", null, body, h("div", {
            style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", marginTop: 6 },
          }, "当前没有已添加的视觉模型：在宿主设置里给某个模型的 input 加上 image 即可。"));
        }
      }
      return h(SettingRow, {
        title: "视觉模型",
        last: true,
        desc: "会话模型不支持图片输入时，截图先交给它看图、再把文字描述交回 Agent。" +
          "默认「系统推荐」按宿主适配器偏好取首个；「随机」每次重新挑一个。",
        control: body,
      });
    }

    // ── 版本与更新：自建更新通道，不依赖插件市场 ──
    //
    // 数据源是服务端 GET/POST /api/x-control/update（lib/core/updater.js 的作业控制器）。
    // 打开设置页自动检查一次；只有真拿到更高的版本号才渲染更新按钮——
    // 拿不到就明说失败原因，不给一个永远点不动的"已是最新"。
    function UpdatePanel(props) {
      var st = react.useState({
        available: true, status: "idle", busy: false, stage: "",
        current: "", latest: "", updateAvailable: false,
        checkedAt: 0, error: "", failedPhase: "", result: null,
      });
      var s = st[0], setState = st[1];

      function pull() {
        return api("/update").then(function (r) {
          setState(function (prev) { return Object.assign({}, prev, r); });
        }).catch(function () { /* 轮询会再试，不打断设置页其余部分 */ });
      }
      function doCheck(force) {
        return api("/update", { action: "check", force: force === true })
          .then(function (r) { setState(function (prev) { return Object.assign({}, prev, r, { busy: false }); }); })
          .catch(function (e) {
            setState(function (prev) {
              return Object.assign({}, prev, { status: "error", busy: false, failedPhase: "check", error: String((e && e.message) || e).slice(0, 80) });
            });
          });
      }
      function doApply() {
        setState(function (prev) { return Object.assign({}, prev, { status: "working", busy: true, error: "", stage: "正在准备…" }); });
        api("/update", { action: "apply" })
          .then(pull)
          .catch(function (e) {
            setState(function (prev) {
              return Object.assign({}, prev, { busy: false, status: "error", failedPhase: "apply", error: String((e && e.message) || e).slice(0, 120) });
            });
          });
      }

      // 打开设置页即自动检查。
      react.useEffect(function () {
        var alive = true;
        api("/update", { action: "check" }).then(function (r) {
          if (alive) setState(function (prev) { return Object.assign({}, prev, r, { busy: false }); });
        }).catch(function () { /* 首屏留"正在检查…"，用户可手动重试 */ });
        return function () { alive = false; };
      }, []);
      // 只有作业进行中才轮询阶段；收工即停，不在设置页上留常驻定时器。
      react.useEffect(function () {
        if (s.busy !== true) return undefined;
        var alive = true;
        var timer = setInterval(function () { if (alive) pull(); }, 1200);
        return function () { alive = false; clearInterval(timer); };
      }, [s.busy]);

      var mono = { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 13 };

      var text;
      var button;
      if (s.available === false) {
        text = "自更新服务不可用：" + (s.error || "宿主未注入更新控制器");
        button = null;
      } else if (s.busy === true) {
        text = s.stage || "处理中…";
        button = h(ActionButton, { disabled: true }, "更新中…");
      } else if (s.failedPhase === "apply") {
        text = "更新失败：" + s.error + "（已保持原版本，可重试）";
        button = h(ActionButton, { onClick: doApply }, "重试更新");
      } else if (s.failedPhase === "check") {
        text = "检查失败：" + s.error;
        button = h(ActionButton, { onClick: function () { doCheck(true); } }, "重试");
      } else if (s.status === "done" && s.result) {
        text = "已更新到 " + s.result.to + "，重启 DSH 后生效。备份在 " + s.result.backupDir + "，删掉该目录即可回滚。";
        button = h(ActionButton, { onClick: function () { doCheck(true); } }, "检查更新");
      } else if (s.updateAvailable === true) {
        text = "发现新版本 " + s.latest + "（当前 " + s.current + "）";
        button = h(ActionButton, { primary: true, onClick: doApply }, "更新到 " + s.latest);
      } else if (s.checkedAt > 0) {
        text = "已是最新版本。";
        button = h(ActionButton, { onClick: function () { doCheck(true); } }, "检查更新");
      } else {
        text = "正在检查…";
        button = null;
      }

      return h(SettingCard, null,
        h(SettingRow, {
          title: "当前版本",
          desc: "插件自更新不走插件市场：直接比对 GitHub 上的最新版本，需要时点右侧按钮换装。",
          control: h("span", { style: mono }, s.current || "读取中…"),
        }),
        h(SettingRow, {
          title: "检查更新",
          desc: text + "　打开本页会自动检查一次；换装会替换插件文件，重启 DSH 后新版本才生效。",
          control: button,
        }),
        h(SettingRow, {
          title: "更新镜像（可选）", last: true,
          desc: "直连全部失败时才用的兜底前缀，例如 https://gh-proxy.org/ 。留空 = 只走直连。" +
            "本机实测直连中位 78ms/523ms，比镜像快 1.4~3 倍，镜像只解决“连不上”不解决“慢”。",
          control: h("input", {
            type: "text", placeholder: "留空 = 直连",
            defaultValue: props.updateMirror || "",
            style: { width: 220, fontSize: 12 },
            onBlur: function (e) { if (props.setMirror) props.setMirror(String(e.target.value || "").trim()); },
          }),
        }));
    }

    // ── 工具栏图标按钮：ZCode ghost icon 样式（无边框、hover 反白、可按压态）──
    function ToolButton(props) {
      var active = props.active === true;
      return h("button", {
        type: "button", title: props.title, disabled: props.disabled === true,
        "aria-pressed": props.pressed, onClick: props.onClick,
        style: {
          width: 28, height: 28, borderRadius: 6, border: "none", padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          background: active ? "rgba(127,127,127,0.28)" : "none",
          color: "inherit", cursor: props.disabled === true ? "default" : "pointer",
          opacity: props.disabled === true ? 0.4 : 1,
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

    // ── 工具栏图标：与 ZCode 浏览器面板同款（lucide），SVG 路径取自其 renderer 分包原文 ──
    // 映射实证：后退=chevron-left、前进=chevron-right、刷新=refresh-cw（加载时 animate-spin）、
    // 自由尺寸=monitor-smartphone、元素选择=mouse-pointer-click、更多=ellipsis；
    // 菜单项：在默认浏览器中打开=external-link（调试工具按需求移除）。
    function Lucide(props) {
      return h("svg", {
        width: (props && props.size) || 16, height: (props && props.size) || 16,
        viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", style: props && props.style,
      }, props.paths.map(function (p, i) {
        return h(p.tag, Object.assign({ key: i }, p.attrs));
      }));
    }
    var ICON_PATHS = {
      back: [{ tag: "path", attrs: { d: "m15 18-6-6 6-6" } }],
      forward: [{ tag: "path", attrs: { d: "m9 18 6-6-6-6" } }],
      reload: [
        { tag: "path", attrs: { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } },
        { tag: "path", attrs: { d: "M21 3v5h-5" } },
        { tag: "path", attrs: { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } },
        { tag: "path", attrs: { d: "M8 16H3v5" } },
      ],
      responsive: [
        { tag: "path", attrs: { d: "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" } },
        { tag: "path", attrs: { d: "M10 19v-3.96 3.15" } },
        { tag: "path", attrs: { d: "M7 19h5" } },
        { tag: "rect", attrs: { width: "6", height: "10", x: "16", y: "12", rx: "2" } },
      ],
      picker: [
        { tag: "path", attrs: { d: "M14 4.1 12 6" } },
        { tag: "path", attrs: { d: "m5.1 8-2.9-.8" } },
        { tag: "path", attrs: { d: "m6 12-1.9 2" } },
        { tag: "path", attrs: { d: "M7.2 2.2 8 5.1" } },
        { tag: "path", attrs: { d: "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" } },
      ],
      more: [
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "1" } },
        { tag: "circle", attrs: { cx: "19", cy: "12", r: "1" } },
        { tag: "circle", attrs: { cx: "5", cy: "12", r: "1" } },
      ],
      external: [
        { tag: "path", attrs: { d: "M15 3h6v6" } },
        { tag: "path", attrs: { d: "M10 14 21 3" } },
        { tag: "path", attrs: { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" } },
      ],
      x: [
        { tag: "path", attrs: { d: "M18 6 6 18" } },
        { tag: "path", attrs: { d: "m6 6 12 12" } },
      ],
    };
    // 刷新按钮加载态的旋转（ZCode: animate-spin）。内联样式做不了 keyframes，注入一次。
    var cxStyleDone = false;
    function ensureCxStyle() {
      if (cxStyleDone || typeof document === "undefined") return;
      try {
        var el = document.createElement("style");
        el.textContent = "@keyframes cx-spin{to{transform:rotate(360deg)}}";
        document.head.appendChild(el);
        cxStyleDone = true;
      } catch (e) { /* 无 document 时跳过 */ }
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
      var pairMenu = react.useState(false);
      var menuOpen = pairMenu[0], setMenuOpen = pairMenu[1];
      var pairResp = react.useState(false);
      var responsive = pairResp[0], setResponsive = pairResp[1];
      var pairPick = react.useState(false);
      var picking = pairPick[0], setPicking = pairPick[1];
      var pairBusy = react.useState(false);
      var busy = pairBusy[0], setBusy = pairBusy[1];
      var imgRef = react.useRef(null);
      var frameRef = react.useRef(null);
      var frameSize = react.useRef({ w: 1280, h: 800 });
      var urlFocused = react.useRef(false);
      var prevTabRef = react.useRef(null);
      var rootRef = react.useRef(null);
      var pairLive = react.useState(true);
      var live = pairLive[0], setLive = pairLive[1];

      // 可见性门控：面板切到别的侧栏 tab、或被窗口最小化时，组件仍挂载但无人观看。
      // 不门控则 screencast 持续编码、帧持续经 webServer 推到渲染进程，纯空转。
      react.useEffect(function () {
        var el = rootRef.current;
        if (!el) return undefined;
        var onScreen = true;
        function sync() {
          setLive(onScreen && document.visibilityState !== "hidden");
        }
        var io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(function (entries) {
          onScreen = !!entries[entries.length - 1].isIntersecting;
          sync();
        }, { threshold: 0 });
        if (io) io.observe(el);
        document.addEventListener("visibilitychange", sync);
        sync();
        return function () {
          if (io) io.disconnect();
          document.removeEventListener("visibilitychange", sync);
        };
      }, []);

      // 轮询标签页列表（面板可见期间每 3 秒）
      react.useEffect(function () {
        if (!live) return undefined;
        var alive = true;
        function load() {
          api("/tabs").then(function (d) {
            if (!alive) return;
            var tabs = (d && d.tabs) || [];
            setState(function (s) { return Object.assign({}, s, { tabs: tabs }); });
            // 登录窗口被手动关掉（服务端已自动回无头）：横幅状态跟着复位
            if (d && d.loginActive === false) {
              setLoginState(function (s) { return s === "window" ? "idle" : s; });
            }
            setSelected(function (cur) {
              if (cur && tabs.some(function (t) { return t.id === cur; })) return cur;
              return tabs.length ? tabs[0].id : null;
            });
          }).catch(function () { /* 忽略轮询失败 */ });
        }
        load();
        var timer = setInterval(load, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, [live]);

      // 地址栏跟随选中标签页（输入中不打断）
      react.useEffect(function () {
        if (urlFocused.current) return;
        var cur = null;
        for (var i = 0; i < state.tabs.length; i++) {
          if (state.tabs[i].id === selected) { cur = state.tabs[i]; break; }
        }
        setUrlDraft(cur && cur.url ? cur.url : "");
      }, [selected, state.tabs]);

      // 订阅选中标签页的 SSE 帧流（仅面板可见时）
      react.useEffect(function () {
        if (!selected || !live) return undefined;
        // 切换标签页必须丢掉上一页的帧：否则新页首帧到达前会挂着旧页的画面
        // （静态页只发一帧，挂着的就是错的）。live 恢复时不重置，保留断流前的最后画面。
        if (prevTabRef.current !== selected) {
          prevTabRef.current = selected;
          frameRef.current = null;
          setState(function (s) { return s.hasFrame ? Object.assign({}, s, { hasFrame: false }) : s; });
        }
        var es = new EventSource(API + "/stream?tab=" + encodeURIComponent(selected));
        es.onmessage = function (e) {
          try {
            var f = JSON.parse(e.data);
            frameSize.current = { w: f.w || 1280, h: f.h || 800 };
            // 帧必须落到 ref 里持久保存：首帧到达时 img 往往还没挂载（hasFrame 仍是 false），
            // 只往 imgRef.current.src 写会丢掉这一帧——静态页之后再无新帧，img 就以空 src
            // 上屏，表现为永远的碎图。ref 回调挂载时补上 src。
            frameRef.current = { src: "data:image/jpeg;base64," + f.data };
            if (imgRef.current) imgRef.current.src = frameRef.current.src;
            setState(function (s) { return s.hasFrame ? s : Object.assign({}, s, { hasFrame: true }); });
          } catch (err) { /* 心跳等非帧消息 */ }
        };
        return function () { es.close(); };
      }, [selected, live]);

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

      // 工具栏导航（ZCode：刷新图标在加载期间旋转）
      function nav(action) {
        if (!selected) { flashNote("暂无标签页"); return; }
        setBusy(true);
        api("/nav", { tab: selected, action: action }).then(function (r) {
          expect(r);
          if (r && r.tab) setUrlDraft(r.tab.url || "");
          setTimeout(function () { setBusy(false); }, 400);
        }).catch(function (e) {
          setBusy(false);
          flashNote((action === "back" ? "后退" : action === "forward" ? "前进" : "刷新") + "失败：" + ((e && e.message) || e));
        });
      }

      // 地址栏回车导航
      function go() {
        var target = normalizeUrl(urlDraft);
        if (!target) return;
        setBusy(true);
        api("/navigate", selected ? { tab: selected, url: target } : { url: target }).then(function (r) {
          expect(r);
          if (r && r.tab) {
            setSelected(r.tab.id);
            setUrlDraft(r.tab.url || target);
          }
          setTimeout(function () { setBusy(false); }, 400);
        }).catch(function (e) { setBusy(false); flashNote("导航失败：" + ((e && e.message) || e)); });
      }

      // 在系统默认浏览器中打开
      function openExternal() {
        if (!selected) { flashNote("暂无标签页"); return; }
        api("/open-external", { tab: selected }).then(function (r) {
          expect(r);
          flashNote("已在默认浏览器打开");
        }).catch(function (e) { flashNote("打开失败：" + ((e && e.message) || e)); });
      }

      // 自由尺寸：视口宽度贴合面板宽（页面回流，画面 1:1 可读）；关闭恢复 1280×800。
      // 尺寸条可精确指定 W×H（对齐 ZCode 的 393 × 852 栏）与缩放档位。
      // 注意 pairZoom/zoom 必须在这里声明：main 构建要读 zoom，var 赋值不提升。
      var pairDim = react.useState({ w: "", h: "" });
      var dim = pairDim[0], setDim = pairDim[1];
      var pairZoom = react.useState(null);
      var zoom = pairZoom[0], setZoom = pairZoom[1];
      function fitViewport() {
        if (!selected) return;
        var el = rootRef.current;
        if (!el) return;
        var w = Math.max(320, Math.round(el.getBoundingClientRect().width) - 20);
        var h = Math.round(w * 0.625);
        setDim({ w: String(w), h: String(h) });
        api("/viewport", { tab: selected, width: w, height: h }).catch(function () { /* 忽略 */ });
      }
      function applyViewport(w, h) {
        if (!selected) return;
        var wi = Math.max(320, Math.round(Number(w) || 0));
        var hi = Math.max(240, Math.round(Number(h) || 0));
        setDim({ w: String(wi), h: String(hi) });
        api("/viewport", { tab: selected, width: wi, height: hi }).catch(function () { /* 忽略 */ });
      }
      function toggleResponsive() {
        var next = !responsive;
        setResponsive(next);
        if (!selected) { flashNote("暂无标签页"); return; }
        if (next) fitViewport();
        else api("/viewport", { tab: selected, width: 1280, height: 800 }).catch(function () { /* 忽略 */ });
      }
      react.useEffect(function () {
        if (!responsive || !selected) return undefined;
        var el = rootRef.current;
        if (!el || typeof ResizeObserver === "undefined") return undefined;
        var t = null;
        var ro = new ResizeObserver(function () {
          if (t) clearTimeout(t);
          t = setTimeout(fitViewport, 200);
        });
        ro.observe(el);
        return function () { ro.disconnect(); if (t) clearTimeout(t); };
      }, [responsive, selected]);

      // 元素选择（对齐 ZCode"选择网页元素加入聊天"）：进入模式后悬停即高亮（CDP Overlay），
      // 点击把元素定位信息追加进会话输入框草稿（Agent 直接可引用），剪贴板兜底。
      function pickAt(p) {
        if (!selected) return;
        api("/pick", { tab: selected, x: p.x, y: p.y }).then(function (r) {
          expect(r);
          var sel = (r && r.selector) || "";
          var desc = "网页元素：" + (r && r.tag ? "<" + r.tag + ">" : "") +
            (sel ? " 选择器 `" + sel + "`" : "") +
            (r && r.text ? " 文本「" + r.text + "」" : "");
          var added = appendToComposer(desc);
          if (!added) {
            try { if (navigator.clipboard) navigator.clipboard.writeText(sel).catch(function () { /* 拒绝则以提示为准 */ }); } catch (e2) { /* 忽略 */ }
            flashNote(added ? "" : "已复制选择器：" + sel);
            return;
          }
          flashNote("已加入聊天：" + desc);
        }).catch(function (e) { flashNote("选择失败：" + ((e && e.message) || e)); });
      }
      var hoverLast = 0;
      function hoverAt(p) {
        if (!selected) return;
        var now = Date.now();
        if (now - hoverLast < 150) return;
        hoverLast = now;
        api("/hover", { tab: selected, x: p.x, y: p.y }).catch(function () { /* 高亮失败不打扰 */ });
      }
      function togglePicking() {
        var next = !picking;
        setPicking(next);
        if (!selected) { flashNote("暂无标签页"); return; }
        if (next) api("/pick-start", { tab: selected }).catch(function () { /* 忽略 */ });
        else api("/pick-stop", { tab: selected }).catch(function () { /* 忽略 */ });
      }

      // ⋯ 菜单：点外面即关
      var menuRef = react.useRef(null);
      react.useEffect(function () {
        if (!menuOpen) return undefined;
        function close(e) {
          if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
        }
        document.addEventListener("mousedown", close, true);
        return function () { document.removeEventListener("mousedown", close, true); };
      }, [menuOpen]);

      // 登录流程（先例：ego-browser 的「已登录，保存」横幅）：
      // 弹出登录窗口 = 同一持久化 profile 临时切有头；已登录，保存 = 关掉有头回无头，登录态已落盘。
      var pairLogin = react.useState("idle");
      var loginState = pairLogin[0], setLoginState = pairLogin[1];
      var pairBanner = react.useState(true);
      var bannerVisible = pairBanner[0], setBannerVisible = pairBanner[1];
      function currentUrl() {
        for (var i = 0; i < state.tabs.length; i++) {
          if (state.tabs[i].id === selected) return state.tabs[i].url || "";
        }
        return "";
      }
      function popLoginWindow() {
        var u = currentUrl();
        if (!u) { flashNote("暂无页面可登录"); return; }
        api("/login-window", { url: u }).then(function (r) {
          expect(r);
          if (r && r.tab) setSelected(r.tab.id);
          setLoginState("window");
          flashNote("登录窗口已弹出（面板画面同步显示）");
        }).catch(function (e) { flashNote("弹出失败：" + ((e && e.message) || e)); });
      }
      function loginDone() {
        var u = currentUrl();
        api("/login-done", { url: u }).then(function (r) {
          expect(r);
          if (r && r.tab) setSelected(r.tab.id);
          setLoginState("idle");
          flashNote("登录态已保存到本插件浏览器的持久化配置");
        }).catch(function (e) { flashNote("保存失败：" + ((e && e.message) || e)); });
      }

      // 面板标签 chip 的 ×（关闭单个标签页）。失败必须显式报错：
      // 乐观移除后 3s 轮询会把它拉回来，表现成"关不掉"。
      function closeTab(id) {
        var rest = state.tabs.filter(function (t) { return t.id !== id; });
        api("/close-tab", { tab: id }).then(function (r) {
          expect(r);
          setState(function (s) { return Object.assign({}, s, { tabs: s.tabs.filter(function (t) { return t.id !== id; }) }); });
          if (id === selected) setSelected(rest.length ? rest[0].id : null);
        }).catch(function (e) { flashNote("关闭失败：" + ((e && e.message) || e)); });
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

      // 工具栏对齐 ZCode：后退/前进/刷新 + 地址栏 + 自由尺寸 + 元素选择 + ⋯ 菜单
      ensureCxStyle();
      var spinStyle = busy ? { animation: "cx-spin 1s linear infinite" } : undefined;
      function menuItem(iconPaths, label, disabled, onClick, hint) {
        return h("button", {
          type: "button", disabled: disabled === true, title: hint,
          onClick: function () { setMenuOpen(false); if (onClick) onClick(); },
          style: {
            display: "flex", gap: 8, alignItems: "center", width: "100%", padding: "6px 8px",
            fontSize: 12, border: "none", borderRadius: 6, background: "none", color: "inherit",
            cursor: disabled === true ? "default" : "pointer", opacity: disabled === true ? 0.4 : 1,
            textAlign: "left",
          },
        }, h(Lucide, { paths: iconPaths }), h("span", null, label));
      }
      var moreMenu = h("div", { ref: menuRef, style: { position: "relative", flexShrink: 0 } },
        h(ToolButton, {
          title: "更多浏览器操作", active: menuOpen,
          onClick: function () { setMenuOpen(!menuOpen); },
        }, h(Lucide, { paths: ICON_PATHS.more })),
        menuOpen ? h("div", {
          style: {
            position: "absolute", right: 0, top: 32, minWidth: 208, zIndex: 60, padding: 4,
            background: "var(--dsw-alias-bg-elevated, #23242a)", color: "var(--dsw-alias-label-primary, #eee)",
            border: "1px solid rgba(127,127,127,0.35)", borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          },
        },
          menuItem(ICON_PATHS.external, "在默认浏览器中打开", !selected, openExternal)) : null);

      var toolbar = h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
        h(ToolButton, { title: "后退", disabled: !selected, onClick: function () { nav("back"); } },
          h(Lucide, { paths: ICON_PATHS.back })),
        h(ToolButton, { title: "前进", disabled: !selected, onClick: function () { nav("forward"); } },
          h(Lucide, { paths: ICON_PATHS.forward })),
        h(ToolButton, { title: "刷新", disabled: !selected, onClick: function () { nav("reload"); } },
          h(Lucide, { paths: ICON_PATHS.reload, style: spinStyle })),
        h("input", {
          value: urlDraft,
          placeholder: "输入网址后回车",
          spellCheck: false,
          onFocus: function () { urlFocused.current = true; },
          onBlur: function () { urlFocused.current = false; },
          onChange: function (e) { setUrlDraft(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter") go(); },
          style: {
            flex: 1, minWidth: 0, height: 28, padding: "0 10px", fontSize: 12, borderRadius: 8,
            border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit",
          },
        }),
        h(ToolButton, {
          title: responsive ? "退出自由尺寸" : "自由尺寸", active: responsive, disabled: !selected,
          onClick: toggleResponsive,
        }, h(Lucide, { paths: ICON_PATHS.responsive })),
        h(ToolButton, {
          title: picking ? "取消网页元素选择" : "选择网页元素", active: picking, disabled: !selected,
          onClick: togglePicking,
        }, h(Lucide, { paths: ICON_PATHS.picker })),
        moreMenu);

      var tabBar = h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
        state.tabs.map(function (t) {
          var active = t.id === selected;
          return h("div", {
            key: t.id,
            style: {
              display: "flex", alignItems: "center", gap: 2, padding: "2px 4px 2px 8px", fontSize: 12,
              borderRadius: 6, minWidth: 0,
              border: "1px solid " + (active ? "#4a7dff" : "rgba(127,127,127,0.35)"),
              background: "none", color: "inherit", fontWeight: active ? 600 : 400,
            },
          },
            h("button", {
              type: "button", title: t.url || t.id, onClick: function () { setSelected(t.id); },
              style: { border: "none", background: "none", color: "inherit", fontSize: 12, cursor: "pointer", padding: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, (t.title || t.url || t.id).slice(0, 24)),
            h("button", {
              type: "button", title: "关闭标签页", onClick: function () { closeTab(t.id); },
              style: { display: "flex", alignItems: "center", border: "none", background: "none", color: "inherit", cursor: "pointer", padding: "1px 3px", opacity: 0.55, borderRadius: 4 },
            }, h(Lucide, { paths: ICON_PATHS.x, size: 12 })));
        }));

      // 空状态对齐 ZCode：撑满面板居中（大图标 + 标题 + 一句提示），无虚线框；
      // 按键行与底部提示只在有画面时出现。
      var emptyish = {
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 6, flex: 1, minHeight: 260, padding: 20, textAlign: "center",
        color: "var(--dsw-alias-label-secondary, #888)",
      };
      var main;
      if (!state.tabs.length) {
        main = h("div", { style: emptyish },
          h(GlobeIcon, { size: 44 }),
          h("div", { style: { fontSize: 14, fontWeight: 600 } }, "浏览器"),
          h("div", { style: { fontSize: 12 } }, "粘贴或输入 URL 以打开网页。"));
      } else if (!state.hasFrame) {
        main = h("div", { style: emptyish },
          h(GlobeIcon, { size: 44 }),
          h("div", { style: { fontSize: 13 } }, "等待画面…"));
      } else {
        // 缩放只改显示倍率：pos() 按实际显示矩形换算，坐标映射在任意缩放下都正确
        var frameW = frameSize.current.w || 1280;
        main = h("div", {
          style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", borderRadius: 6 },
        },
          h("img", {
            ref: function (el) {
              imgRef.current = el;
              if (el && frameRef.current && el.src !== frameRef.current.src) el.src = frameRef.current.src;
            },
            alt: "浏览器实时画面",
            style: {
              width: zoom ? Math.round(frameW * zoom) + "px" : "100%", maxWidth: "none",
              flexShrink: 0, display: "block", cursor: picking ? "crosshair" : "pointer",
              borderRadius: 6, background: "#111",
            },
            onClick: function (e) {
              var p = pos(e);
              if (picking) { pickAt(p); return; }
              relay({ type: "click", x: p.x, y: p.y });
            },
            onMouseMove: function (e) {
              if (!picking) return;
              hoverAt(pos(e));
            },
            onWheel: function (e) { var p = pos(e); relay({ type: "scroll", x: p.x, y: p.y, deltaY: e.deltaY }); },
          }));
      }

      // 登录横幅（对齐 ego-browser 的「已登录，保存」）。
      // 按钮颜色写死：主题 alias 变量在本机主题解析成白色，白底白字不可见。
      var loginBanner = !bannerVisible ? null : h("div", {
        style: {
          display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", fontSize: 11, lineHeight: 1.5,
          background: "rgba(74,125,255,0.10)", border: "1px solid rgba(74,125,255,0.35)", borderRadius: 8,
          color: "var(--dsw-alias-label-secondary, #bbb)",
        },
      },
        h("span", { style: { flex: 1, minWidth: 0 } }, loginState === "window"
          ? "登录完成后点右侧按钮保存，登录态会留在本浏览器。"
          : "需要登录的页面，先弹出登录窗口完成登录。"),
        h("button", {
          type: "button", onClick: loginState === "window" ? loginDone : popLoginWindow,
          style: { flexShrink: 0, padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "none", background: "#4a7dff", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" },
        }, loginState === "window" ? "已登录，保存" : "弹出登录窗口"),
        h("button", {
          type: "button", title: "收起", onClick: function () { setBannerVisible(false); },
          style: { flexShrink: 0, display: "flex", alignItems: "center", width: 18, height: 18, borderRadius: 4, border: "none", background: "none", color: "inherit", cursor: "pointer", opacity: 0.6, padding: 0 },
        }, h(Lucide, { paths: ICON_PATHS.x, size: 12 })));

      // 自由尺寸的尺寸栏：对齐 ZCode 的通栏贴条样式——全宽、无输入框边框、内容居中，
      // 顶边贴住地址栏（负 margin 抵消根容器 padding 与 gap）。zoom=null 即自适应窗口。
      var dimBar = !responsive ? null : h("div", { style: {
          display: "flex", gap: 16, alignItems: "center", justifyContent: "center",
          margin: "-8px -10px 0", padding: "6px 12px",
          background: "rgba(127,127,127,0.10)", fontSize: 12,
          color: "var(--dsw-alias-label-secondary, #999)",
        } },
        h("input", {
          value: dim.w, title: "视口宽度，回车生效",
          onChange: function (e) { setDim({ w: e.target.value, h: dim.h }); },
          onKeyDown: function (e) { if (e.key === "Enter") applyViewport(dim.w, dim.h); },
          style: { width: 44, padding: 0, fontSize: 12, border: "none", outline: "none", background: "transparent", color: "inherit", textAlign: "center" },
        }),
        h("span", { style: { opacity: 0.5 } }, "×"),
        h("input", {
          value: dim.h, title: "视口高度，回车生效",
          onChange: function (e) { setDim({ w: dim.w, h: e.target.value }); },
          onKeyDown: function (e) { if (e.key === "Enter") applyViewport(dim.w, dim.h); },
          style: { width: 44, padding: 0, fontSize: 12, border: "none", outline: "none", background: "transparent", color: "inherit", textAlign: "center" },
        }),
        h("select", {
          value: zoom === null ? "fit" : String(zoom),
          title: "画面缩放",
          // color-scheme=dark 让原生下拉弹层走深色；option 再显式上色双保险
          onChange: function (e) { setZoom(e.target.value === "fit" ? null : Number(e.target.value)); },
          style: { fontSize: 12, border: "none", outline: "none", background: "transparent", color: "inherit", padding: 0, colorScheme: "dark" },
        },
          h("option", { value: "fit", style: { background: "#23242a", color: "#eee" } }, "自适应窗口"),
          h("option", { value: "0.5", style: { background: "#23242a", color: "#eee" } }, "50%"),
          h("option", { value: "0.75", style: { background: "#23242a", color: "#eee" } }, "75%"),
          h("option", { value: "1", style: { background: "#23242a", color: "#eee" } }, "100%"),
          h("option", { value: "1.25", style: { background: "#23242a", color: "#eee" } }, "125%"),
          h("option", { value: "1.5", style: { background: "#23242a", color: "#eee" } }, "150%"),
          h("option", { value: "2", style: { background: "#23242a", color: "#eee" } }, "200%")));

      return h("div", { ref: rootRef, style: { display: "flex", flexDirection: "column", gap: 8, padding: 10, flex: 1, minHeight: 0 } },
        toolbar,
        dimBar,
        loginBanner,
        // 提示行：单行省略，不抢高度
        state.hasFrame ? h("div", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #777)", minWidth: 0 } },
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, picking
            ? "元素选择中：悬停高亮、点击加入聊天输入框；再点上方按钮退出。"
            : "点击画面回传到无头浏览器（不影响桌面）；文本输入让 Agent 用 x_browser_fill。"),
          h("span", { style: { flexShrink: 0, color: "#4a7dff" } }, state.note)) : null,
        state.tabs.length ? tabBar : null,
        main);
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

    // ── 会话输入框工具行左侧的 X-Agent 按钮（conversation.input.left）──
    // 槽位契约（宿主 dsh-cordis-client-runner 内置的 slot 清单）：
    //   conversation.input.left  = "Compact controls at the left of the composer tool row."
    //   conversation.input.overlay = "Floating entries rendered inside the resident composer card."
    // 起初错用了 overlay：它渲染在 composer 卡的 overlayAnchor 浮层里，是给斜杠菜单、
    // 命令弹窗这类浮动面板用的，行内按钮放进去会悬在占位文字上（宿主 ui-commands 的
    // command-popup、ui-input-trigger 的 slash-menu 都注册在那里）。
    // 该槽位的标准 props 含 inputActions（composer 写入面）与 useInput（InputState 快照），
    // 暂存到模块级，右侧面板"元素加入聊天"借它把选中元素写进会话输入框草稿。
    var composerWrite = null; // { setDraft(text) }
    var composerDraft = "";
    function appendToComposer(text) {
      if (!composerWrite || typeof composerWrite.setDraft !== "function") return false;
      composerWrite.setDraft((composerDraft ? composerDraft + "\n" : "") + text);
      return true;
    }
    function InputActionButton(props) {
      var state = typeof props.useCxSettings === "function"
        ? props.useCxSettings(function (s) { return s; })
        : undefined;
      if (props.inputActions && typeof props.inputActions.setDraft === "function") {
        composerWrite = props.inputActions;
      }
      if (typeof props.useInput === "function") {
        try {
          var inputSnap = props.useInput(function (s) { return s; });
          if (inputSnap && typeof inputSnap.draft === "string") composerDraft = inputSnap.draft;
        } catch (e) { /* useInput 不可用时跳过 */ }
      }
      if (state && state.inputButtonEnabled === false) return null;
      // 只留图标：文字版会跟工具行的「+ / 模式选择」抢宽度，名字放进 title 提示。
      return h("button", {
        type: "button", title: "打开 X-Agent 浏览器面板", "aria-label": "X-Agent",
        style: {
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 4, borderRadius: 8, border: "none",
          background: "none", cursor: "pointer", color: "inherit", opacity: 0.85,
        },
        onClick: function () { if (!openRightTab()) setPanelOpen(!panelOpen); },
      }, h(ControlXIcon, { size: 16 }));
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

    // ══ 顶部横幅 + 活动联动 ══
    //
    // 为什么挂 document.body 而不是 slot：横幅本质是全窗口浮层（position:fixed），
    // 与宿主布局无关；而可用 seat 名随宿主版本变化（本机 0.2.0-rc.2 的 client-ui-layout
    // 的 lib 是空包、席位名在应用侧声明），依赖某个 seat 等于赌宿主版本。
    //
    // 只画网页内这一层是不够的：它只存在于 DSH 窗口的渲染层，Agent 操控记事本时
    // 用户盯着记事本，横幅被压在下面看不见——2026-10-01 实测就是这么"没提示"的。
    // Windows 上真正的置顶浮窗由宿主进程侧的 banner-win.js 负责，本模块在
    // /activity 报 overlay=true 时主动隐藏网页内这一份，避免同时出现两个横幅。
    var ACTIVE_POLL_MS = 600;   // 活跃时：横幅要跟得上动作节奏
    var IDLE_POLL_MS = 2500;    // 空闲时：不让一个装饰元素长期打接口
      var BANNER_ATTR = "data-dhcx-activity";

    function mountActivityBanner(ctx) {
      if (typeof document === "undefined") return function () {};

      var reduceMotion = typeof matchMedia === "function"
        && matchMedia("(prefers-reduced-motion: reduce)").matches;

      var host = document.createElement("div");
      host.setAttribute(BANNER_ATTR, "banner");
      host.style.cssText = [
        "position:fixed", "top:10px", "left:50%", "transform:translateX(-50%)",
        "z-index:2147483000", "pointer-events:none", "opacity:0",
        "transition:opacity .18s ease",
      ].join(";");

      var box = document.createElement("div");
      box.setAttribute(BANNER_ATTR, "box");
      box.style.cssText = [
        "display:flex", "align-items:center", "gap:10px",
        "padding:9px 18px", "border-radius:8px", "max-width:70vw",
        // 背景框颜色随宿主主题：--dsw-alias-bg-elevated 在浅色/深色主题下解析成不同值，
        // 所以切主题时横幅自己跟着变；不用 --dsw-alias-brand-primary（在本机解析成白色）。
        "background:var(--dsw-alias-bg-elevated, #23242a)",
        "border:1px solid rgba(127,127,127,0.3)",
        "box-shadow:0 8px 28px rgba(0,0,0,0.3)",
        "color:var(--dsw-alias-label-primary, #eee)",
        "font:500 13px/1.5 var(--dsw-font-family,system-ui,-apple-system,Segoe UI,sans-serif)",
        "white-space:nowrap", "overflow:hidden",
      ].join(";");

      var dot = document.createElement("span");
      dot.setAttribute(BANNER_ATTR, "dot");
      // Red -> amber -> blue, 2s each, so a 6s loop. step-end makes it a hard
      // switch rather than a cross-fade; reduced-motion keeps a single colour.
      dot.style.cssText = "width:9px;height:9px;border-radius:50%;flex:none;"
        + "background:" + (reduceMotion ? "#3b82f6" : "#ef4444") + ";"
        + (reduceMotion ? "" : "animation:dsh-control-x-dot 6s step-end infinite;");

      var label = document.createElement("span");
      label.setAttribute(BANNER_ATTR, "text");

      // No caret: it blinked at 1.25Hz and read as the banner itself flickering
      // (user 2026-10-02, alongside removing the typing effect).
      box.appendChild(dot);
      box.appendChild(label);
      host.appendChild(box);
      document.body.appendChild(host);

      if (!reduceMotion) {
        var style = document.createElement("style");
        style.textContent = "@keyframes dsh-control-x-dot{0%{background:#ef4444}"
          + "33.333%{background:#eab308}66.667%{background:#3b82f6}}";
        document.head.appendChild(style);
      }

      // Static text, no typing animation and no caret (user 2026-10-02).
      // The status dot's colour cycle is the only animation left.
      var base = "X-Agent正在控制电脑，操控键鼠会打断操作";
      var pollTimer = null;

      function show() {
        host.style.opacity = "1";
        label.textContent = base;
      }
      function hide() {
        host.style.opacity = "0";
      }

      function apply(snap) {
        // 原生置顶浮窗在跑时，网页里这份必须让位——两个横幅叠在一起比一个更糟。
        if (snap && snap.overlay === true) { hide(); return; }
        if (!snap || snap.active !== true) { hide(); return; }
        show();
      }

      // 浏览器活跃 → 弹出右侧栏。
      // 一"轮"只弹一次：否则每个 600ms 轮询都会重复 openTab，用户面板被反复抢。
      var browserBurst = false;
      function onBrowserActive(snap) {
        var now = !!(snap && snap.active === true && snap.kind === "browser");
        if (now && !browserBurst) openRightTab();
        browserBurst = now;
      }

      // 主题色上报：原生浮窗是独立进程，读不到 --dsw-alias-* 这些 CSS 变量，
      // 只能由这里把解析结果送过去，切深浅色时跟着变。
      function pushTheme() {
        try {
          var cs = window.getComputedStyle(document.body);
          api("/activity-theme", {
            bg: cs.getPropertyValue("--dsw-alias-bg-elevated").trim(),
            fg: cs.getPropertyValue("--dsw-alias-label-primary").trim(),
          }).catch(function () { /* 服务不可达：浮窗用默认配色 */ });
        } catch (e) { /* 无 getComputedStyle：同上 */ }
      }
      pushTheme();
      var themeObserver = null;
      try {
        themeObserver = new MutationObserver(pushTheme);
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
      } catch (e) { themeObserver = null; }

      function tick() {
        var delay = IDLE_POLL_MS;
        api("/activity").then(function (snap) {
          apply(snap);
          onBrowserActive(snap);
          delay = snap && snap.active === true ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        }).catch(function () {
          hide(); // 插件被停用/路由消失：横幅必须自己消失，不能留下假的"正在操控"
        }).then(function () {
          pollTimer = setTimeout(tick, delay);
        });
      }

      function onVisible() { if (document.visibilityState === "visible") tick(); }
      document.addEventListener("visibilitychange", onVisible);
      tick();

      return function dispose() {
        if (pollTimer !== null) clearTimeout(pollTimer);
        if (typeTimer !== null) clearInterval(typeTimer);
        if (themeObserver !== null) themeObserver.disconnect();
        document.removeEventListener("visibilitychange", onVisible);
        host.remove();
      };
    }

    function apply(ctx) {
      rootCtx = ctx;
      var settings = createSettingsStore();

      // 顶部横幅：常驻挂载，按 /activity 的状态显示/隐藏（不需要用户先开面板）。
      ctx.effect(function () {
        return mountActivityBanner(ctx);
      }, "dsh-control-x: activity banner");

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
        // order 100：排在宿主自带控件（+ / 模式选择）之后。
        raw.effect(function () {
          return raw.slots.inject("conversation.input.left", function () {
            return raw.slots.register({
              name: "conversation.input.left",
              id: "control-x",
              order: 100,
              locale: NS,
              inject: function () {
                return { hooks: { cxSettings: settings.store } };
              },
            }, function (props) { return h(InputActionButton, props); });
          });
        }, "dsh-control-x: input left button");
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

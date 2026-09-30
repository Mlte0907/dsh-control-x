/**
 * 宿主 raw JSON Schema 子集：规范化 + 自检。
 *
 * 为什么需要这一层（2026-10-01 实测缺陷，勿删）：
 * 宿主 `ctx.tools.register()`（@deepseek-ai/dsh-tools 0.2.0-rc.2，
 * app.asar 内 lib/index.js:2878-2890）第一步就是
 * `assertSupportedJsonSchema(output.schema)`，不合子集**直接抛错**。
 * 而插件的 `parameters` 用的是宿主 defineTool 的 **property-map DSL**
 * （property 上写 `required: true`，见 docs/DSH-SDK-CONTRACT.md §1），
 * 这个写法被顺手照搬进了 `output.schema`——那是 **raw JSON Schema**，
 * `required` 必须是字符串数组、且不能挂在标量属性上。
 * 结果：21 个工具 100% 被注册门拒收，而插件的 safeRegister 用 try/catch
 * 吞掉异常只写日志 → 用户侧完全静默（面板在、skill 在、工具一个都没有）。
 *
 * 这里的两个职责：
 * - `toHostSchema()`：注册前把 property-map 写法改写成标准 raw JSON Schema；
 *   插件自己的参数校验仍走改写前的原 schema（`validateAgainstSchema`），
 *   保持既有宽松语义不变，只修「发给宿主/模型的那一份」。
 * - `checkHostSchema()`：自检镜像宿主会拒绝的几种形态，供单测与验收脚本使用。
 *   它是宿主规则的**子集镜像**，不是宿主本身；真正的门是
 *   `npm run verify:contract`（从运行中的 app.asar 里抽宿主真校验器来跑）。
 */

/** 把 property-map DSL 里的 `required: true` 提升为 raw JSON Schema 的根 required 数组。 */
export function toHostSchema(schema) {
  return rewrite(schema);
}

function rewrite(node) {
  if (Array.isArray(node)) return node.map(rewrite);
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  const hoisted = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && value === true) continue; // 根级布尔：随后由 hoisted/原数组取代
    if (key === 'required' && Array.isArray(value)) { out.required = [...value]; continue; }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {};
      for (const [name, child] of Object.entries(value)) {
        // 必须在改写**之前**看原始子节点：rewrite 会把子节点自己的 required:true 丢掉，
        // 改完再看就永远看不到，嵌套对象的必填名会静默丢进垃圾桶（2026-10-01 自测抓出）。
        const declaredRequired = child !== null && typeof child === 'object' && !Array.isArray(child)
          && child.required === true;
        if (declaredRequired) hoisted.push(name);
        properties[name] = rewrite(child);
      }
      out.properties = properties;
      continue;
    }
    out[key] = rewrite(value);
  }
  if (hoisted.length > 0) {
    out.required = [...new Set([...(out.required ?? []), ...hoisted])];
  }
  return out;
}

const MIRRORED_HOST_RULES = [
  'required 必须是字符串数组',
  'required 里的名字必须在 properties 里声明过',
  '标量节点上不允许出现 required',
  'type 与 oneOf 不能同时声明',
];

/**
 * 自检：返回违规说明数组，空数组 = 通过。
 * 镜像宿主 assertSupportedJsonSchema 对本插件所用形态会拒绝的规则，
 * 逐条对应 app.asar 内 dsh-tools/lib/types/json-schema.js 的 checkSchemaNode / checkObjectSchemaTail。
 */
export function checkHostSchema(schema, path = 'schema') {
  const violations = [];
  walk(schema, path, violations, new Set());
  return violations;
}

function walk(node, path, violations, seen) {
  if (node === true || node === undefined) return;
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} 必须是 schema 对象`);
    return;
  }
  if (seen.has(node)) {
    violations.push(`${path} 是循环引用`);
    return;
  }
  seen.add(node);

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${path} 不能同时声明 type 和 oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} 需要 type 或 oneOf`);
    }
  }

  // 判定顺序照抄宿主：先看该节点是否允许出现 required，再看它是不是字符串数组。
  // 宿主原文（json-schema.js）：标量节点报 `required is not supported on type "boolean"`，
  // 对象节点报 `schema.required must be an array of strings`——两者不是同一条检查。
  if (Object.hasOwn(node, 'required')) {
    if (node.type !== undefined && node.type !== 'object' && !hasOneOf) {
      violations.push(`${path}.required 在 type "${node.type}" 上不受支持（宿主原文：required is not supported on type "${node.type}"）`);
    } else {
      const required = node.required;
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required 必须是字符串数组（宿主原文：required must be an array of strings）`);
      } else {
        const declared = node.properties ?? {};
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${path}.required 里的 "${key}" 未在 properties 中声明`);
        }
      }
    }
  }

  for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${name}`, violations, seen);
  if (node.items !== undefined) walk(node.items, `${path}.items`, violations, seen);
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((sub, i) => walk(sub, `${path}.oneOf[${i}]`, violations, seen));
  seen.delete(node);
}

export { MIRRORED_HOST_RULES };

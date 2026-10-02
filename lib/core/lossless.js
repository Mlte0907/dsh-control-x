/**
 * 宿主「无损 JSON」边界的插件侧镜像。
 *
 * 宿主对工具返回值的处理顺序（app.asar 内 dsh-tools/lib/index.js createSuccessResult，
 * 2026-10-02 抽源核实）：**先**用 @deepseek-ai/dsh-util-values 的 snapshotJsonValue
 * 做无损快照，**再**用 output.schema 校验。快照失败整单拒绝，报错只有一句
 * 「value is not lossless JSON」，不说坏在哪。快照拒绝的值：
 * - 非有限数（NaN / ±Infinity）与 -0；
 * - 原型不纯净的数组/对象（子类、Date/Map/类实例；跨 realm 判定本镜像从简为本征 prototype）；
 * - 带空洞或多余自有属性的数组（Reflect.ownKeys 长度 ≠ length + 1）；
 * - Symbol 或不可枚举的自有键；
 * - 一切 JSON 之外的类型，**包括嵌套的 undefined**；
 * - 循环引用。
 *
 * 为什么插件侧还要再设一道门（0.5.10 血泪）：x_status 曾因 cfg 漏写
 * bannerIdleExitMs getter 而返回 undefined 字段，宿主判「value is not lossless JSON」，
 * 而本仓库全部测试都直接调 execute、不经过宿主，75 个测试全绿照样翻车。
 * 这道门把宿主那句不给定位的报错换成点名道姓的路径，并让测试当场抓住。
 */

/** 逐节点检查宿主无损 JSON 规则，返回路径限定的违规说明；空数组 = 通过。 */
export function losslessJsonViolations(value, path = 'value') {
  const violations = [];
  walk(value, path, violations, new Set());
  return violations;
}

function walk(value, path, violations, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      violations.push(`"${path}" 必须是有限 JSON 数值且不得为 -0`);
    }
    return;
  }
  if (type !== 'object') {
    violations.push(`"${path}" 是 ${type}，JSON 无法无损表示（嵌套 undefined 也在此列）`);
    return;
  }
  if (seen.has(value)) {
    violations.push(`"${path}" 是循环引用`);
    return;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        violations.push(`"${path}" 的原型不是 Array.prototype（数组子类被宿主拒绝）`);
        return;
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        violations.push(`"${path}" 的自有键数与 length 不符（空洞或多余自有属性的数组被宿主拒绝）`);
        return;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          violations.push(`"${path}[${index}]" 是空洞，JSON 序列化会把它悄悄变成 null`);
          continue;
        }
        walk(value[index], `${path}[${index}]`, violations, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      violations.push(`"${path}" 的原型不是 Object.prototype / null（Date、Map、类实例等宿主一律拒绝）`);
      return;
    }
    const keys = Reflect.ownKeys(value);
    const badKeys = keys.filter((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key));
    if (badKeys.length > 0) {
      violations.push(`"${path}" 的自有键 [${badKeys.map(String).join(', ')}] 是 Symbol 或不可枚举，宿主整单拒绝`);
      return;
    }
    for (const key of keys) {
      walk(value[key], `${path}.${key}`, violations, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * 自研工具工厂：产出 tools.register() 直接消费的普通对象。
 *
 * 契约依据（docs/DSH-SDK-CONTRACT.md §1、§8）：
 * - register(definition) 只要求 { name, output:{schema,render}, execute }，
 *   但 output.schema 必须通过宿主的 assertSupportedJsonSchema（原生 JSON Schema 子集），
 *   不通过 register 直接抛错（dsh-tools/lib/index.js:2878-2890）。
 * - parameters 与 output.schema 是**两套不同方言**：前者是宿主 defineTool 的
 *   property-map DSL（property 上可以写 required:true），后者是 raw JSON Schema
 *   （required 必须是字符串数组）。本文件用 toHostSchema 在注册边界统一改写，
 *   细节与踩坑见 core/host-schema.js 顶部注释——2026-10-01 这里曾导致 21 个工具
 *   全部被宿主拒收且用户侧零感知。
 * - 参数校验是 defineTool 在 execute 外包的一层；绕开宿主包后由本文件承担。
 * - 未知/抛错工具成为结构化错误且不结束回合（README:123），所以这里把一切异常
 *   归一为 ControlXError。
 */

import { toHostSchema } from './host-schema.js';

/** 值是否符合单个 type 声明。 */
function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * 极简 JSON Schema 校验器（覆盖本插件自用子集：
 * type / required / properties / items / enum / oneOf / description）。
 * 返回违规说明数组；空数组 = 通过。路径用于模型可读的报错。
 */
export function validateAgainstSchema(schema, value, path = 'args', violations = []) {
  if (schema === true || schema === undefined) return violations;
  if (schema === false) {
    violations.push(`${path} 不允许有值`);
    return violations;
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.some((sub) => {
      const trial = [];
      validateAgainstSchema(sub, value, path, trial);
      return trial.length === 0;
    });
    if (!ok) violations.push(`${path} 不匹配 oneOf 的任何分支`);
    return violations;
  }
  if (schema.enum) {
    if (!schema.enum.some((candidate) => candidate === value)) {
      violations.push(`${path} 必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')} 之一`);
    }
    return violations;
  }
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    violations.push(`${path} 需要 ${types.join(' | ')} 类型，实际是 ${value === null ? 'null' : typeof value}`);
    return violations;
  }
  if (Array.isArray(schema.items) === false && schema.items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateAgainstSchema(schema.items, item, `${path}[${index}]`, violations);
    }
  }
  if (schema.properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(schema.properties)) {
      if (value[key] === undefined) continue;
      validateAgainstSchema(schema.properties[key], value[key], `${path}.${key}`, violations);
    }
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) {
        violations.push(`${path}.${required} 是必填项`);
      }
    }
  }
  return violations;
}

/** 注册前自查：schema 缺省允许（视为空参数表），给了就必须是对象。 */
function assertSchemaUsable(schema, label) {
  if (schema !== undefined && schema !== null && (typeof schema !== 'object' || Array.isArray(schema))) {
    throw new Error(`${label} 必须是 JSON Schema 对象`);
  }
}

/**
 * @param {object} options
 * @param {string} options.name 工具名（x_ 前缀）。
 * @param {string} options.description 模型可见说明。
 * @param {object} [options.parameters] JSON Schema（object 根）。
 * @param {object} options.outputSchema 输出的 JSON Schema。
 * @param {(args: object, value: object) => Array<object>} options.render
 *   输出 → content block 数组；默认 JSON 文本块。
 * @param {(args: object, exec: object) => Promise<object>} options.execute
 *   返回值必须匹配 outputSchema。
 * @param {boolean} [options.isConcurrencySafe] 只读工具标记（PTC 并行依据）。
 * @returns {object} tools.register() 可直接消费的定义。
 */
export function defineXTool({ name, description, parameters, outputSchema, render, execute, isConcurrencySafe }) {
  const params = parameters ?? { type: 'object', properties: {} };
  assertSchemaUsable(params, `${name}.parameters`);
  assertSchemaUsable(outputSchema, `${name}.output.schema`);
  if (typeof render !== 'function') throw new Error(`${name} 必须提供 render`);
  if (name === 'run_code') throw new Error('run_code 是宿主保留名');

  const hostOutputSchema = toHostSchema(outputSchema);
  const requiredOutputKeys = Array.isArray(hostOutputSchema.required) ? hostOutputSchema.required : [];

  const wrappedExecute = async (args, exec) => {
    const violations = validateAgainstSchema(params, args ?? {}, 'args', []);
    if (violations.length > 0) {
      const err = new Error(`${name} 参数不合法：${violations.join('；')}`);
      err.name = 'ControlXArgsError';
      throw err;
    }
    const value = await execute(args ?? {}, exec);
    // 宿主会用 output.schema 校验工具返回值（2026-10-01 真机 E2E 实测：
    // 少一个必填键，整个调用被判 "missing required property value.ok"）。
    // 本仓库所有测试都直接调 execute()、绕过这道校验，所以在这里自检，
    // 把宿主那句含糊的报错换成点名道姓的、能直接定位到实现的错误。
    if (requiredOutputKeys.length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const missing = requiredOutputKeys.filter((key) => !(key in value));
      if (missing.length > 0) {
        throw new ControlXError(
          `${name} 返回值缺自己声明的必填字段 ${missing.join(',')}——` +
          `宿主会用 output.schema 校验返回值，缺任一项都会判本次调用失败（宿主原文：missing required property "value.${missing[0]}"）。`,
          { code: 'INTERNAL', details: { missing } },
        );
      }
    }
    return value;
  };

  return {
    name,
    description,
    // 注册边界统一改写成宿主 raw JSON Schema 子集；execute 仍按原 params 校验，
    // 所以模型侧看得见 required 数组，插件内部的宽松语义不变。
    parameters: toHostSchema(params),
    output: {
      schema: hostOutputSchema,
      render,
    },
    execute: wrappedExecute,
    ...(isConcurrencySafe === true ? { isConcurrencySafe: true } : {}),
  };
}

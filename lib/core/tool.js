/**
 * 自研工具工厂：产出 tools.register() 直接消费的普通对象。
 *
 * 契约依据（docs/DSH-SDK-CONTRACT.md §1、§8）：
 * - register(definition) 只要求 { name, output:{schema,render}, execute }，
 *   output.schema 必须通过宿主的 assertSupportedJsonSchema（原生 JSON Schema 子集），
 *   无任何宿主包身份检查（dsh-tools/lib/index.js:2878-2887）。
 * - 参数校验是 defineTool 在 execute 外包的一层；绕开宿主包后由本文件承担。
 * - 未知/抛错工具成为结构化错误且不结束回合（README:123），所以这里把一切异常
 *   归一为 ControlXError。
 */

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

  const wrappedExecute = async (args, exec) => {
    const violations = validateAgainstSchema(params, args ?? {}, 'args', []);
    if (violations.length > 0) {
      const err = new Error(`${name} 参数不合法：${violations.join('；')}`);
      err.name = 'ControlXArgsError';
      throw err;
    }
    return await execute(args ?? {}, exec);
  };

  return {
    name,
    description,
    parameters: params,
    output: {
      schema: outputSchema,
      render,
    },
    execute: wrappedExecute,
    ...(isConcurrencySafe === true ? { isConcurrencySafe: true } : {}),
  };
}

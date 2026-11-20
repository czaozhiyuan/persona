import { resolveOpticalChannel } from './channels';
import type { EmpiricalValue, NumericRange, ParameterDefinition, ParameterValue } from './parameters';
import { requireValid } from './validation';

export function validateChannelIds(ids: readonly string[], context: string): void {
  requireValid(ids.length > 0 && new Set(ids).size === ids.length, `${context}: 光通道 ID 列表不能为空或包含重复项`);
  for (const id of ids) requireValid(resolveOpticalChannel(id), `${context}: 无效的光通道「${id}」`);
}

export function validateRange({ min, max }: NumericRange, context: string): void {
  requireValid(min !== undefined || max !== undefined, `${context}: 至少需要设置一个限值`);
  requireValid((min === undefined || Number.isFinite(min)) && (max === undefined || Number.isFinite(max))
    && (min === undefined || max === undefined || min <= max), `${context}: 数值范围无效`);
}

export function validateEmpirical(
  value: EmpiricalValue, kinds: readonly EmpiricalValue['kind'][], context: string, range?: NumericRange,
): void {
  requireValid(kinds.includes(value.kind), `${context}: 无效的经验值类型「${value.kind}」`);
  const validateNumber = (n: number | undefined) => requireValid(n !== undefined && Number.isFinite(n)
    && (range?.min === undefined || n >= range.min) && (range?.max === undefined || n <= range.max),
    `${context}: 应为指定范围内的有限数值`);
  if (value.kind === 'fixed') {
    validateNumber(value.value);
  } else if (value.kind === 'rfCurve') {
    requireValid(value.points.length > 0, `${context}: 射频曲线至少需要一个频点`);
    let previous = -Infinity;
    for (const [frequencyGHz, y] of value.points) {
      requireValid(Number.isFinite(frequencyGHz) && frequencyGHz >= 0 && frequencyGHz > previous,
        `${context}: 射频频率须为非负有限数值，并严格递增`);
      validateNumber(y);
      previous = frequencyGHz;
    }
  } else {
    const entries = Object.entries(value.values);
    validateChannelIds(entries.map(([id]) => id), context);
    for (const [, n] of entries) validateNumber(n);
  }
}

export function validateParameterValue(definition: ParameterDefinition, value: ParameterValue, context: string): void {
  if (definition.kind === 'enum') {
    requireValid(typeof value === 'string' && definition.options.includes(value), `${context}: 枚举值无效`);
  } else {
    requireValid(typeof value !== 'string', `${context}: 应为经验值`);
    validateEmpirical(value, [definition.valueKind], context, definition.range);
  }
}

export function validateParameterDefinition(definition: ParameterDefinition, context: string): void {
  if (definition.kind === 'enum') {
    requireValid(definition.options.length > 0 && definition.options.every(option => option.trim())
      && new Set(definition.options).size === definition.options.length, `${context}: 枚举选项不能为空或重复`);
  } else if (definition.range) {
    validateRange(definition.range, context);
  }
  if (definition.defaultValue !== undefined) validateParameterValue(definition, definition.defaultValue, context);
}

/** A parent can forward only values that the receiving child parameter accepts. */
export function parameterCanFeed(source: ParameterDefinition, target: ParameterDefinition): boolean {
  if (source.kind === 'enum') {
    return target.kind === 'enum' && source.options.every(value => target.options.includes(value));
  }
  return target.kind === 'numeric' && source.unit === target.unit && source.valueKind === target.valueKind
    && (source.range?.min ?? -Infinity) >= (target.range?.min ?? -Infinity)
    && (source.range?.max ?? Infinity) <= (target.range?.max ?? Infinity);
}

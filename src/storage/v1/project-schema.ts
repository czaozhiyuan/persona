import { receiverModes } from '../../model/v1/device';
import { componentIconKeys } from '../../model/v1/types';
import type { Project } from '../../model/v1/types';

export class ProjectStructureError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ProjectStructureError';
  }
}

type Check = (value: unknown, path: string) => void;

function fail(path: string, message: string): never {
  throw new ProjectStructureError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '应为对象');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, '应为普通工程数据');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) {
      fail(path, '字段应为可枚举的字符串键');
    }
  }
  return value as Record<string, unknown>;
}

function fieldPath(path: string, key: string): string {
  return /^[a-zA-Z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

const text: Check = (value, path) => { if (typeof value !== 'string') fail(path, '应为字符串'); };
const number: Check = (value, path) => { if (!Number.isFinite(value)) fail(path, '应为有限数值'); };
const boolean: Check = (value, path) => { if (typeof value !== 'boolean') fail(path, '应为布尔值'); };

function oneOf(...values: string[]): Check {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) fail(path, `应为以下值之一：${values.join('、')}`);
  };
}

function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value, path) => {
    const data = record(value, path);
    for (const key of Object.keys(data)) {
      if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(fieldPath(path, key), '未知字段');
    }
    for (const [key, check] of Object.entries(required)) {
      const location = fieldPath(path, key);
      if (!Object.hasOwn(data, key)) fail(location, '缺少必填字段');
      check(data[key], location);
    }
    for (const [key, check] of Object.entries(optional)) {
      if (Object.hasOwn(data, key) && data[key] !== undefined) check(data[key], fieldPath(path, key));
    }
  };
}

function list(check: Check, length?: number): Check {
  return (value, path) => {
    if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
      fail(path, length === undefined ? '应为数组' : `应为包含 ${length} 个元素的数组`);
    }
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
      fail(path, '应为连续且无额外属性的数组');
    }
    for (let i = 0; i < value.length; i++) {
      const location = `${path}[${i}]`;
      const entry = Object.getOwnPropertyDescriptor(value, String(i));
      if (!entry || !('value' in entry)) fail(location, '该位置缺少数组元素');
      check(entry.value, location);
    }
  };
}

function dictionary(check: Check): Check {
  return (value, path) => {
    for (const [key, entry] of Object.entries(record(value, path))) check(entry, fieldPath(path, key));
  };
}

function byKind(variants: Record<string, Check>): Check {
  return (value, path) => {
    const kind = record(value, path).kind;
    if (typeof kind !== 'string' || !Object.hasOwn(variants, kind)) fail(`${path}.kind`, '不支持此类型');
    variants[kind](value, path);
  };
}

const identity = { id: text, name: text };
const limits = { min: number, max: number };
const channels = list(text);
const instancePath = list(text);
const endpoint = shape({ instancePath, portId: text });
const localPort = shape({ instanceId: text, portId: text });
const fixed = shape({ kind: oneOf('fixed'), value: number });
const rfCurve = shape({ kind: oneOf('rfCurve'), points: list(list(number, 2)) });
const channelTable = shape({ kind: oneOf('channelTable'), values: dictionary(number) });
const parameterRef = shape({ kind: oneOf('parameter'), parameterId: text });
const empirical = byKind({ fixed, rfCurve, channelTable });
const rfQuantity = byKind({ fixed, rfCurve, parameter: parameterRef });
const opticalQuantity = byKind({ fixed, channelTable, parameter: parameterRef });
const dcQuantity = byKind({ fixed, parameter: parameterRef });
const dcCapacity = shape({ unit: oneOf('W', 'A'), value: dcQuantity });
const parameterValue: Check = (value, path) => {
  if (typeof value !== 'string') empirical(value, path);
};
const parameter = byKind({
  numeric: shape({
    ...identity, kind: oneOf('numeric'), unit: oneOf('dB', 'dBm', 'V', 'A', 'W', 'GHz', 'nm', 'A/W', 'V/W', 'W/V', 'ohm', 'ratio', '%'),
    valueKind: oneOf('fixed', 'rfCurve', 'channelTable', 'rfValue', 'opticalValue'),
  }, { overridable: boolean, range: shape({}, limits), defaultValue: empirical }),
  enum: shape({ ...identity, kind: oneOf('enum'), options: list(text) }, { overridable: boolean, defaultValue: text }),
});
const port = shape({ id: text, type: oneOf('RF', 'OPTICAL', 'DC_POWER', 'AC_POWER', 'CONTROL'), direction: oneOf('in', 'out', 'bidirectional') }, {
  side: oneOf('top', 'left'),
  name: text, channelIds: channels, opticalEmitter: shape({}, { powerDbm: opticalQuantity }), inputVoltageV: dcQuantity, outputVoltageV: dcQuantity,
  acLoadW: dcQuantity, supplyCapacity: shape({ unit: oneOf('W', 'A'), value: fixed }), inputRating: shape({ unit: oneOf('dBm', 'V', 'A', 'W') }, limits),
});
const portPair = { fromPortId: text, toPortId: text };
const opticalOptions = { channelIds: channels, gainDb: opticalQuantity };
const transfer = byKind({
  rf: shape({ ...portPair, kind: oneOf('rf') }, { gainDb: rfQuantity, nfDb: rfQuantity }),
  optical: shape({ ...portPair, kind: oneOf('optical') }, { ...opticalOptions, insertionLossDb: opticalQuantity }),
  wavelengthConversion: shape({
    ...portPair, kind: oneOf('wavelengthConversion'), fromChannelId: text, toChannelId: text,
  }, { gainDb: opticalQuantity }),
  splitter: shape({ ...portPair, kind: oneOf('splitter'), secondPortId: text }, { firstPercent: dcQuantity, excessLossDb: dcQuantity }),
  digitalTx: shape({ ...portPair, kind: oneOf('digitalTx') }, { channelIds: channels }),
  digitalRx: shape({ ...portPair, kind: oneOf('digitalRx') }, { channelIds: channels, sensitivityDbm: opticalQuantity, overloadDbm: opticalQuantity }),
  dml: shape({ ...portPair, kind: oneOf('dml') }, { channelIds: channels, modulationSlope: rfQuantity }),
  eo: shape({ ...portPair, kind: oneOf('eo') }, {
    channelIds: channels, supplyPortId: text, insertionLossDb: opticalQuantity, vPi: rfQuantity,
  }),
  oe: shape({ ...portPair, kind: oneOf('oe') }, {
    channelIds: channels, responsivity: opticalQuantity, responseDb: rfQuantity, loadedGain: rfQuantity,
    receiver: (value, path) => typeof value === 'string' ? oneOf(...receiverModes)(value, path) : parameterRef(value, path),
  }),
  dc: shape({ ...portPair, kind: oneOf('dc') }, { efficiency: dcQuantity, capacity: dcCapacity }),
});
const definition = { ...identity, ports: list(port) };
const footprint = { widthMm: number, depthMm: number };
const component = shape({ ...definition, kind: oneOf('component') }, {
  wdm: boolean,
  iconKey: oneOf(...componentIconKeys),
  physicalFootprint: shape(footprint),
  parameters: list(parameter), transfers: list(transfer),
  switchStates: list(shape({ ...identity, routes: list(shape(portPair, opticalOptions)) })),
  dcSupply: (value, path) => {
    if (value && typeof value === 'object') fail(path, '旧单路电源结构：请将各路电压和容量写入对应直流输出端口，并将 dcSupply 设为 true。');
    boolean(value, path);
  },
  dcLoad: shape({ portId: text }, { powerW: dcQuantity }),
});
const instance = shape({ ...identity, definitionId: text }, {
  parameterOverrides: dictionary(parameterValue), switchStateId: text,
});
const cableSide = shape({ pin: number }, { endpoint: localPort });
const moduleDefinition = shape({ ...definition, kind: oneOf('module'), instances: list(instance) }, {
  parameters: list(parameter),
  connections: list(shape({ id: text, from: localPort, to: localPort }, {
    mediaKind: oneOf('OPTICAL_FIBER', 'RF_COAX', 'RJ45_CABLE'), lossDb: number,
  })),
  cableBundles: list(shape({ id: text, coreCount: number, cores: list(shape({ id: text, a: cableSide, b: cableSide }, { lossDb: number })) })),
  portMappings: list(shape({ portId: text, target: localPort }, { id: text })),
  parameterMappings: list(shape({ parameterId: text, target: shape({ instanceId: text, parameterId: text }) })),
  physicalEnclosure: shape({ ...footprint, heightMm: number }),
});
const connectionRef = shape({ scopePath: instancePath, connectionId: text });
const cableCoreRef = shape({ scopePath: instancePath, bundleId: text, coreId: text });
const requiredEdge: Check = (value, path) => {
  const fields = record(value, path);
  const check = Object.hasOwn(fields, 'bundleId') || Object.hasOwn(fields, 'coreId') ? cableCoreRef : connectionRef;
  check(value, path);
};
const link = shape(identity, {
  from: endpoint, to: endpoint, channelId: text, via: list(requiredEdge),
  trial: shape({ frequencyGHz: number }, { inputPowerDbm: number,
    opticalSources: list(shape({ endpoint }, { channelId: text, powerDbm: number })) }),
});
const projectShape = shape({
  ...identity, rootModuleDefinitionId: text, componentDefinitions: list(component), moduleDefinitions: list(moduleDefinition),
}, {
  namedLinks: list(link),
  instanceSettings: list(shape({ instancePath }, { name: text, parameterOverrides: dictionary(parameterValue), switchStateId: text })),
  layout: shape({}, {
    physical: list(shape({ instancePath, enclosurePath: instancePath, xMm: number, yMm: number, rotationDeg: number },
      { footprint: shape(footprint) })),
    topology: list(shape({ instancePath, x: number, y: number })),
    topologyWireRoutes: list(shape({ modulePath: instancePath, x: number, y: number, wire: byKind({
      connection: shape({ kind: oneOf('connection'), id: text }),
      mapping: shape({ kind: oneOf('mapping'), id: text }),
      core: shape({ kind: oneOf('core'), id: text, bundleId: text }),
    }) })),
    topologyFrames: list(shape({ modulePath: instancePath, x: number, y: number, width: number, height: number })),
  }),
});

export function assertProjectShape(value: unknown): asserts value is Project {
  projectShape(value, '$.project');
}

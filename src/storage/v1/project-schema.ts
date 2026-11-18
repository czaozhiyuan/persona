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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected plain project data');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) {
      fail(path, 'expected enumerable string data fields');
    }
  }
  return value as Record<string, unknown>;
}

function fieldPath(path: string, key: string): string {
  return /^[a-zA-Z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

const text: Check = (value, path) => { if (typeof value !== 'string') fail(path, 'expected a string'); };
const number: Check = (value, path) => { if (!Number.isFinite(value)) fail(path, 'expected a finite number'); };
const boolean: Check = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected a boolean'); };

function oneOf(...values: string[]): Check {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) fail(path, `expected one of ${values.join(', ')}`);
  };
}

function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value, path) => {
    const data = record(value, path);
    for (const key of Object.keys(data)) {
      if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(fieldPath(path, key), 'unknown field');
    }
    for (const [key, check] of Object.entries(required)) {
      const location = fieldPath(path, key);
      if (!Object.hasOwn(data, key)) fail(location, 'required field is missing');
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
      fail(path, length === undefined ? 'expected an array' : `expected a ${length}-element tuple`);
    }
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
      fail(path, 'expected a dense array without extra properties');
    }
    for (let i = 0; i < value.length; i++) {
      const location = `${path}[${i}]`;
      const entry = Object.getOwnPropertyDescriptor(value, String(i));
      if (!entry || !('value' in entry)) fail(location, 'expected an array data entry');
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
    if (typeof kind !== 'string' || !Object.hasOwn(variants, kind)) fail(`${path}.kind`, 'unsupported kind');
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
const rfValue = byKind({ fixed, rfCurve });
const rfQuantity = byKind({ fixed, rfCurve, parameter: parameterRef });
const opticalQuantity = byKind({ fixed, channelTable, parameter: parameterRef });
const parameterValue: Check = (value, path) => {
  if (typeof value !== 'string') empirical(value, path);
};
const parameter = byKind({
  numeric: shape({
    ...identity, kind: oneOf('numeric'), unit: oneOf('dB', 'dBm', 'V', 'A', 'W', 'GHz', 'nm', 'ohm', 'ratio'),
    valueKind: oneOf('fixed', 'rfCurve', 'channelTable'),
  }, { overridable: boolean, range: shape({}, limits), defaultValue: empirical }),
  enum: shape({ ...identity, kind: oneOf('enum'), options: list(text) }, { overridable: boolean, defaultValue: text }),
});
const port = shape({ id: text, type: oneOf('RF', 'OPTICAL', 'DC_POWER', 'CONTROL'), direction: oneOf('in', 'out') }, {
  channelIds: channels, inputRating: shape({ unit: oneOf('dBm', 'V', 'A', 'W') }, limits),
});
const portPair = { fromPortId: text, toPortId: text };
const opticalOptions = { channelIds: channels, gainDb: opticalQuantity };
const transfer = byKind({
  rf: shape({ ...portPair, kind: oneOf('rf') }, { gainDb: rfQuantity, nfDb: rfQuantity }),
  optical: shape({ ...portPair, kind: oneOf('optical') }, opticalOptions),
  wavelengthConversion: shape({
    ...portPair, kind: oneOf('wavelengthConversion'), fromChannelId: text, toChannelId: text,
  }, { gainDb: opticalQuantity }),
  eo: shape({ ...portPair, kind: oneOf('eo') }, { ...opticalOptions, supplyPortId: text }),
  oe: shape({ ...portPair, kind: oneOf('oe') }, { channelIds: channels }),
  dc: shape({ ...portPair, kind: oneOf('dc') }),
});
const definition = { ...identity, ports: list(port) };
const component = shape({ ...definition, kind: oneOf('component') }, {
  parameters: list(parameter), transfers: list(transfer),
  switchStates: list(shape({ ...identity, routes: list(shape(portPair, opticalOptions)) })),
});
const instance = shape({ ...identity, definitionId: text }, {
  parameterOverrides: dictionary(parameterValue), switchStateId: text,
});
const cableSide = shape({ pin: number }, { endpoint: localPort });
const moduleDefinition = shape({ ...definition, kind: oneOf('module'), instances: list(instance) }, {
  parameters: list(parameter),
  connections: list(shape({ id: text, from: localPort, to: localPort }, {
    mediaKind: oneOf('OPTICAL_FIBER', 'RF_COAX', 'RJ45_CABLE'),
  })),
  cableBundles: list(shape({ id: text, coreCount: number, cores: list(shape({ id: text, a: cableSide, b: cableSide })) })),
  portMappings: list(shape({ portId: text, target: localPort })),
  parameterMappings: list(shape({ parameterId: text, target: shape({ instanceId: text, parameterId: text }) })),
  physicalEnclosure: shape({ widthMm: number, depthMm: number, heightMm: number }),
});
const profileValues = { rfGainRefDb: rfValue, pdPowerRefDbm: number };
const profile = shape({ ...identity, ...profileValues }, {
  k: number, applicability: shape({}, { channelIds: channels, notes: text }),
});
const boundary = shape({ instancePath, ...portPair });
const connectionRef = shape({ scopePath: instancePath, connectionId: text });
const cableCoreRef = shape({ scopePath: instancePath, bundleId: text, coreId: text });
const requiredEdge: Check = (value, path) => {
  const fields = record(value, path);
  const check = Object.hasOwn(fields, 'bundleId') || Object.hasOwn(fields, 'coreId') ? cableCoreRef : connectionRef;
  check(value, path);
};
const link = shape(identity, {
  from: endpoint, to: endpoint, channelId: text, via: list(requiredEdge),
  conversionBindings: list(shape({ id: text, profileId: text, eo: boundary, oe: boundary }, {
    overrides: shape({}, { ...profileValues, k: number }),
  })),
});
const projectShape = shape({
  ...identity, rootModuleDefinitionId: text, componentDefinitions: list(component), moduleDefinitions: list(moduleDefinition),
}, {
  conversionProfiles: list(profile), namedLinks: list(link),
  layout: shape({}, {
    physical: list(shape({ instancePath, enclosurePath: instancePath, xMm: number, yMm: number, rotationDeg: number })),
    topology: list(shape({ instancePath, x: number, y: number })),
  }),
});

export function assertProjectShape(value: unknown): asserts value is Project {
  projectShape(value, '$.project');
}

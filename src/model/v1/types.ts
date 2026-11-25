import type { OpticalChannelId } from './channels';
import type { OpticalEmitter, DcLoad, SupplyCapacity, DcValue, InputRating, SwitchState, Transfer } from './device';
import type { ParameterDefinition, ParameterMapping, ParameterValue } from './parameters';
import type { CableBundle, Connection, LocalEndpointRef, NamedLink } from './topology';

/** Root-relative local instance IDs. An empty path identifies the root module. */
export type InstancePath = readonly string[];

export type EndpointRef = {
  instancePath: InstancePath;
  portId: string;
};

/** Connection IDs are local to the module identified by scopePath. */
export type ConnectionRef = {
  scopePath: InstancePath;
  connectionId: string;
};

export type PortType = 'RF' | 'OPTICAL' | 'DC_POWER' | 'AC_POWER' | 'CONTROL';
export function isPowerPort(type?: PortType) { return type === 'DC_POWER' || type === 'AC_POWER'; }
export type PortFlow = 'in' | 'out';
export type PortDirection = PortFlow | 'bidirectional';
export const portDirectionLabels = { in: '输入', out: '输出', bidirectional: '双向' } as const;

export function supportsDirection(direction: PortDirection, flow: PortFlow) {
  return direction === flow || direction === 'bidirectional';
}

export function canConnect(from: PortDirection, to: PortDirection) {
  return supportsDirection(from, 'out') && supportsDirection(to, 'in');
}

export function canMapDirection(outer: PortDirection, inner: PortDirection) {
  return inner === 'bidirectional' || outer === inner;
}

export type PortDefinition = {
  id: string;
  name?: string;
  type: PortType;
  direction: PortDirection;
  side?: 'top';
  channelIds?: readonly OpticalChannelId[];
  opticalEmitter?: OpticalEmitter;
  inputRating?: InputRating;
  /** Nominal input voltage, independent of limits and consumption. AC voltages are RMS. */
  inputVoltageV?: DcValue;
  /** Declared output voltage, independent of supply and converter roles. */
  outputVoltageV?: DcValue;
  supplyCapacity?: SupplyCapacity;
};

type DefinitionIdentity = {
  id: string;
  name: string;
  ports: readonly PortDefinition[];
  parameters?: readonly ParameterDefinition[];
};

export type PhysicalFootprint = { widthMm: number; depthMm: number };

export const componentIconKeys = [
  'laser', 'dml', 'multiWavelengthSource', 'mzm', 'photodiode', 'opticalSwitch', 'opticalAttenuator',
  'amplifier', 'rfAttenuator', 'dcSupply', 'dcConverter', 'controlCircuit', 'splitter', 'sfp',
] as const;
export type ComponentIconKey = typeof componentIconKeys[number];

export type ComponentDefinition = DefinitionIdentity & {
  kind: 'component';
  wdm?: boolean;
  iconKey?: ComponentIconKey;
  physicalFootprint?: PhysicalFootprint;
  transfers?: readonly Transfer[];
  switchStates?: readonly SwitchState[];
  /** Each DC output of a supply feeds its own rail. */
  dcSupply?: boolean;
  dcLoad?: DcLoad;
};

export function isSupplyOutput(definition: ComponentDefinition | ModuleDefinition, port: Pick<PortDefinition, 'type' | 'direction'>) {
  return definition.kind === 'component' && definition.dcSupply === true && port.type === 'DC_POWER' && port.direction === 'out';
}

/** Structural child slot. Its name and settings are defaults shared by occurrences of the parent. */
export type Instance = {
  /** Unique within the containing module definition. */
  id: string;
  name: string;
  definitionId: string;
  parameterOverrides?: Readonly<Record<string, ParameterValue>>;
  switchStateId?: string;
};

/** Local settings for one concrete occurrence, independent of its shared definition. */
export type InstanceSettings = Pick<Instance, 'parameterOverrides' | 'switchStateId'> & {
  instancePath: InstancePath;
  name?: string;
};

/**
 * Connects a public port to one port of a direct child, relative to the
 * owning definition so the same mapping applies to every instance.
 */
export type PortMapping = {
  portId: string;
  target: LocalEndpointRef;
};

export type PhysicalEnclosure = PhysicalFootprint & { heightMm: number };

export type ModuleDefinition = DefinitionIdentity & {
  kind: 'module';
  instances: readonly Instance[];
  connections?: readonly Connection[];
  cableBundles?: readonly CableBundle[];
  portMappings?: readonly PortMapping[];
  parameterMappings?: readonly ParameterMapping[];
  physicalEnclosure?: PhysicalEnclosure;
};

export type PhysicalPlacement = {
  /** A component instance or a module instance with its own physical enclosure. */
  instancePath: InstancePath;
  /** The immediate physical container, independent of the logical parent. */
  enclosurePath: InstancePath;
  /** Millimetres from the enclosure's upper-left corner; right and down are positive. */
  xMm: number;
  yMm: number;
  /** Multiples of 90 degrees, clockwise about the placed instance's local origin at (xMm, yMm). */
  rotationDeg: number;
  /** Optional actual component dimensions, overriding the definition's suggested dimensions. */
  footprint?: PhysicalFootprint;
};

export type TopologyPlacement = {
  instancePath: InstancePath;
  /** Coordinates in the containing module's logical view. */
  x: number;
  y: number;
};

export type TopologyFrame = {
  modulePath: InstancePath;
  /** Bounds in the module's own logical canvas coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WireRef =
  | { kind: 'connection'; id: string }
  | { kind: 'mapping'; id: string }
  | { kind: 'core'; id: string; bundleId: string };

export type TopologyWireRoute = { modulePath: InstancePath; wire: WireRef; x: number; y: number };

export type LayoutState = {
  topologyWireRoutes?: readonly TopologyWireRoute[];
  physical?: readonly PhysicalPlacement[];
  topology?: readonly TopologyPlacement[];
  topologyFrames?: readonly TopologyFrame[];
};

export type Project = {
  id: string;
  name: string;
  rootModuleDefinitionId: string;
  componentDefinitions: readonly ComponentDefinition[];
  moduleDefinitions: readonly ModuleDefinition[];
  namedLinks?: readonly NamedLink[];
  instanceSettings?: readonly InstanceSettings[];
  layout?: LayoutState;
};

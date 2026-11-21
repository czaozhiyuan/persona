import type { OpticalChannelId } from './channels';
import type { ConversionProfile, DcLoad, DcSupply, DcValue, InputRating, SwitchState, Transfer } from './device';
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

export type PortType = 'RF' | 'OPTICAL' | 'DC_POWER' | 'CONTROL';
export type PortDirection = 'in' | 'out';

export type PortDefinition = {
  id: string;
  name?: string;
  type: PortType;
  direction: PortDirection;
  channelIds?: readonly OpticalChannelId[];
  inputRating?: InputRating;
  /** Declared voltage on a DC output. Supply and conversion roles are defined separately. */
  outputVoltageV?: DcValue;
};

type DefinitionIdentity = {
  id: string;
  name: string;
  ports: readonly PortDefinition[];
  parameters?: readonly ParameterDefinition[];
};

export type PhysicalFootprint = { widthMm: number; depthMm: number };

export type ComponentDefinition = DefinitionIdentity & {
  kind: 'component';
  physicalFootprint?: PhysicalFootprint;
  transfers?: readonly Transfer[];
  switchStates?: readonly SwitchState[];
  dcSupply?: DcSupply;
  dcLoad?: DcLoad;
};

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

export type LayoutState = {
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
  conversionProfiles?: readonly ConversionProfile[];
  namedLinks?: readonly NamedLink[];
  instanceSettings?: readonly InstanceSettings[];
  layout?: LayoutState;
};

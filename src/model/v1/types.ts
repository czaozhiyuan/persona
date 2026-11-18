import type { OpticalChannelId } from './channels';
import type { ConversionProfile, InputRating, SwitchState, Transfer } from './device';
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
  type: PortType;
  direction: PortDirection;
  channelIds?: readonly OpticalChannelId[];
  inputRating?: InputRating;
};

type DefinitionIdentity = {
  id: string;
  name: string;
  ports: readonly PortDefinition[];
  parameters?: readonly ParameterDefinition[];
};

export type ComponentDefinition = DefinitionIdentity & {
  kind: 'component';
  transfers?: readonly Transfer[];
  switchStates?: readonly SwitchState[];
};

export type Instance = {
  /** Unique within the containing module definition. */
  id: string;
  name: string;
  definitionId: string;
  parameterOverrides?: Readonly<Record<string, ParameterValue>>;
  switchStateId?: string;
};

/**
 * Connects a public port to one port of a direct child, relative to the
 * owning definition so the same mapping applies to every instance.
 */
export type PortMapping = {
  portId: string;
  target: LocalEndpointRef;
};

export type PhysicalEnclosure = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

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
};

export type TopologyPlacement = {
  instancePath: InstancePath;
  /** Coordinates in the containing module's logical view. */
  x: number;
  y: number;
};

export type LayoutState = {
  physical?: readonly PhysicalPlacement[];
  topology?: readonly TopologyPlacement[];
};

export type Project = {
  id: string;
  name: string;
  rootModuleDefinitionId: string;
  componentDefinitions: readonly ComponentDefinition[];
  moduleDefinitions: readonly ModuleDefinition[];
  conversionProfiles?: readonly ConversionProfile[];
  namedLinks?: readonly NamedLink[];
  layout?: LayoutState;
};

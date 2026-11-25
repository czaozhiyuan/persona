import type { OpticalChannelId } from './channels';
import type { ConnectionRef, EndpointRef, InstancePath } from './types';

/** Relative to the owning module definition. Only direct child ports are addressable. */
export type LocalEndpointRef = { instanceId: string; portId: string };

export type Connection = {
  id: string;
  from: LocalEndpointRef;
  to: LocalEndpointRef;
  mediaKind?: 'OPTICAL_FIBER' | 'RF_COAX' | 'RJ45_CABLE';
  lossDb?: number;
};

export type CableCore = {
  /** Stable within the bundle, even if an attachment or pin number changes. */
  id: string;
  lossDb?: number;
  a: { pin: number; endpoint?: LocalEndpointRef };
  b: { pin: number; endpoint?: LocalEndpointRef };
};

export type CableBundle = {
  id: string;
  coreCount: number;
  /** Owns all mapped fibre connections; bindings do not create separate Connection records. */
  cores: readonly CableCore[];
};

export type CableCoreRef = {
  scopePath: InstancePath;
  bundleId: string;
  coreId: string;
};

/** Identifies the ports of one EO or OE transfer on a concrete component instance. */
export type ConversionBoundary = {
  instancePath: InstancePath;
  fromPortId: string;
  toPortId: string;
};

export type OpticalSource = { endpoint: EndpointRef; channelId?: OpticalChannelId; powerDbm?: number };

export type LinkTrial = {
  frequencyGHz: number;
  inputPowerDbm?: number;
  opticalSources?: readonly OpticalSource[];
};

export type NamedLink = {
  id: string;
  name: string;
  from?: EndpointRef;
  to?: EndpointRef;
  channelId?: OpticalChannelId;
  via?: readonly (ConnectionRef | CableCoreRef)[];
  trial?: LinkTrial;
};

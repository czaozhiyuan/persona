export type PortType = 'RF' | 'OPTICAL' | 'DC_POWER' | 'CONTROL';
export type Empirical =
  | { kind: 'fixed'; value: number }
  | { kind: 'rf'; points: [number, number][] }
  | { kind: 'channel'; values: Record<string, number> };
export type Params = Record<string, Empirical | string>;
export type Endpoint = { instanceId: string; portId: string };
export type Port = { id: string; type: PortType; direction: 'in' | 'out'; channels?: string[] };
export type Transfer = {
  from: string; to: string; kind: 'rf' | 'optical' | 'eo' | 'oe';
  gainDb?: Empirical; nfDb?: Empirical; channels?: string[]; supplyPort?: string;
};
export type ComponentDefinition = {
  id: string; name: string; ports: Port[]; size: { width: number; depth: number };
  params: Params; transfers: Transfer[];
};
export type Instance = { id: string; name: string; definitionId: string; overrides: Params };
export type Connection = { id: string; from: Endpoint; to: Endpoint; gainDb: Empirical };
export type ModuleDefinition = {
  id: string; name: string; ports: Port[]; instances: Instance[]; connections: Connection[];
  mappings: { portId: string; target: Endpoint }[];
  overrides: Record<string, { instanceId: string; parameter: string }[]>;
};
export type Link = {
  id: string; name: string; from: Endpoint; to: Endpoint; channelId?: string;
  viaConnectionIds?: string[];
  conversion?: { gainRefDb: number; powerRefDbm: number; k: number };
};
export type OpticalChannel = {
  id: string; family: 'MM850' | 'CWDM' | 'DWDM_100G';
  label: string; wavelengthNm: number; frequencyTHz?: number;
};
export type LayoutState = {
  physical: Record<string, { x: number; y: number; rotation: number }>;
  topology: Record<string, { x: number; y: number }>;
};
export type Project = {
  schemaVersion: 1; name: string;
  chassis: { width: number; depth: number; height: number };
  channels: OpticalChannel[]; components: ComponentDefinition[]; modules: ModuleDefinition[];
  instances: Instance[]; connections: Connection[]; links: Link[]; layout: LayoutState;
};
export const fixed = (value: number): Empirical => ({ kind: 'fixed', value });
export const endpoint = (instanceId: string, portId: string): Endpoint => ({ instanceId, portId });
export const portKey = (p: Endpoint) => `${p.instanceId}:${p.portId}`;

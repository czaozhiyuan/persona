import type { OpticalChannelId } from './channels';

export type FixedValue = { kind: 'fixed'; value: number };
export type RfCurve = { kind: 'rfCurve'; points: readonly (readonly [frequencyGHz: number, value: number])[] };
export type ChannelTable = { kind: 'channelTable'; values: Readonly<Partial<Record<OpticalChannelId, number>>> };
export type RfValue = FixedValue | RfCurve;
export type OpticalValue = FixedValue | ChannelTable;
export type EmpiricalValue = RfValue | ChannelTable;
export type ParameterValue = EmpiricalValue | string;
export type NumericUnit = 'dB' | 'dBm' | 'V' | 'A' | 'W' | 'GHz' | 'nm' | 'ohm' | 'ratio';
export type NumericRange = { min?: number; max?: number };

type ParameterIdentity = {
  id: string;
  name: string;
  overridable?: boolean;
};

export type NumericParameter = ParameterIdentity & {
  kind: 'numeric';
  unit: NumericUnit;
  valueKind: EmpiricalValue['kind'];
  range?: NumericRange;
  defaultValue?: EmpiricalValue;
};

export type ParameterDefinition = NumericParameter | (ParameterIdentity & {
  kind: 'enum';
  options: readonly string[];
  defaultValue?: string;
});

export type ParameterMapping = {
  parameterId: string;
  target: { instanceId: string; parameterId: string };
};

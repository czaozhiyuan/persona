import type { OpticalChannelId } from './channels';
import type { NumericRange, OpticalValue, RfValue } from './parameters';

export type InputRating = NumericRange & { unit: 'dBm' | 'V' | 'A' | 'W' };

type Quantity<T> = T | { kind: 'parameter'; parameterId: string };
type PortPair = { fromPortId: string; toPortId: string };
type ChannelFilter = { channelIds?: readonly OpticalChannelId[] };

export type OpticalRoute = PortPair & ChannelFilter & { gainDb?: Quantity<OpticalValue> };

export type Transfer =
  | (PortPair & { kind: 'rf'; gainDb?: Quantity<RfValue>; nfDb?: Quantity<RfValue> })
  | (OpticalRoute & { kind: 'optical' })
  | (PortPair & {
    kind: 'wavelengthConversion';
    fromChannelId: OpticalChannelId;
    toChannelId: OpticalChannelId;
    /** Channel tables are indexed by the input channel. */
    gainDb?: Quantity<OpticalValue>;
  })
  | (PortPair & ChannelFilter & {
    kind: 'eo';
    /** The optical input required by externally supplied modulators such as an MZM. */
    supplyPortId?: string;
    gainDb?: Quantity<OpticalValue>;
  })
  | (PortPair & ChannelFilter & { kind: 'oe' })
  | (PortPair & { kind: 'dc' });

export type SwitchState = {
  id: string;
  name: string;
  /** Active optical paths within this state. An empty list opens all paths. */
  routes: readonly OpticalRoute[];
};

export const DEFAULT_CONVERSION_K = 2;

export type ConversionProfile = {
  id: string;
  name: string;
  rfGainRefDb: RfValue;
  pdPowerRefDbm: number;
  /** Omission selects DEFAULT_CONVERSION_K. */
  k?: number;
  applicability?: {
    channelIds?: readonly OpticalChannelId[];
    notes?: string;
  };
};

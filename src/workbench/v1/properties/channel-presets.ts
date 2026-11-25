import type { OpticalChannelId } from '../../../model/v1/channels';

export const wdmChannelPresets: readonly OpticalChannelId[] = [
  ...Array.from({ length: 18 }, (_, i): OpticalChannelId => `CWDM_${1271 + i * 20}`),
  ...Array.from({ length: 11 }, (_, i): OpticalChannelId => `DWDM_CH${20 + i * 2}`),
];

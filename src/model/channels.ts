import type { OpticalChannel } from './types';

// G.694.2 uses 1271..1611 nm. The label preserves the common legacy naming.
// DWDM channel labels here follow Cxx = 190 + xx / 10 THz, not a 50 GHz map.
export const CHANNELS: OpticalChannel[] = [
  { id: 'MM850', family: 'MM850', label: 'MM850 · 850 nm', wavelengthNm: 850 },
  ...Array.from({ length: 18 }, (_, i): OpticalChannel => {
    const wavelengthNm = 1271 + i * 20;
    return { id: `CWDM_${wavelengthNm}`, family: 'CWDM', wavelengthNm, label: `${wavelengthNm - 1} (${wavelengthNm} nm)` };
  }),
  ...Array.from({ length: 73 }, (_, i): OpticalChannel => {
    const channel = i + 1;
    const frequencyTHz = (1900 + channel) / 10;
    return { id: `DWDM_CH${channel}`, family: 'DWDM_100G', frequencyTHz,
      wavelengthNm: 299792.458 / frequencyTHz, label: `CH${channel} · ${frequencyTHz.toFixed(1)} THz` };
  }),
];

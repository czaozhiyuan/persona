export type OpticalChannelId = 'MM850' | `CWDM_${number}` | `DWDM_CH${number}`;

export type OpticalChannel = {
  id: OpticalChannelId;
  family: 'MM850' | 'CWDM' | 'DWDM_100G';
  wavelengthNm: number;
  frequencyTHz?: number;
};

/** Resolves a canonical channel ID to its nominal centre, without rounding an input onto the grid. */
export function resolveOpticalChannel(id: string): OpticalChannel | undefined {
  if (id === 'MM850') return { id, family: 'MM850', wavelengthNm: 850 };
  // ITU-T G.694.2 (12/2003), Table 1.
  const cwdm = /^CWDM_(\d{4})$/.exec(id);
  if (cwdm && cwdm[0] === id) {
    const wavelengthNm = Number(cwdm[1]);
    if (wavelengthNm >= 1271 && wavelengthNm <= 1611 && (wavelengthNm - 1271) % 20 === 0) {
      return { id: `CWDM_${wavelengthNm}`, family: 'CWDM', wavelengthNm };
    }
  }
  // ITU-T G.694.1 (10/2020), section 7: 193.1 + n * 0.1 THz. V1 labels this point CH(n + 31).
  const dwdm = /^DWDM_CH(0|-?[1-9]\d*)$/.exec(id);
  if (dwdm && dwdm[0] === id) {
    const channel = Number(dwdm[1]);
    const frequencyGHz = 190_000 + channel * 100;
    if (Number.isSafeInteger(frequencyGHz) && frequencyGHz > 0) {
      const frequencyTHz = frequencyGHz / 1000;
      return { id: `DWDM_CH${channel}`, family: 'DWDM_100G', frequencyTHz, wavelengthNm: 299_792.458 / frequencyTHz };
    }
  }
  return undefined;
}

import type { ComponentIconKey } from '../../../model/v1/types';

const symbols = {
  laser: 'M2 7h8v10H2zM10 12h4m1-3 6-5m-6 8h8m-8 3 6 5',
  mzm: 'M1 12h3l5-6h6l5 6h3M4 12l5 6h6l5-6M10 2h4m-4 20h4',
  photodiode: 'M2 16h4V9l8 7-8 6v-6m9-7v13m0-6h7M12 2 8 7m0-3v3h3m7-5-4 5m0-3v3h3',
  amplifier: 'M2 12h4m0-9 13 9-13 9zM19 12h3',
  attenuator: 'M2 12h3m14 0h3M5 7h14v10H5zM4 21 20 3m-5 0h5v5',
  opticalSwitch: 'M2 12h5l9-7m1-1h5m-5 15h5M7 12l2 1m3 2 2 1',
  dcSupply: 'M2 12h6m0-4v8m5-12v16m0-8h9M16 5h5m-2.5-2.5v5',
  dcConverter: 'M1 12h3m16 0h3M4 4h16v16H4zM5 19 19 5M7 8h4m2 8h4',
  pcb: 'M3 3h18v18H3zM6 8h4l3 3h5M6 16h4l2-2h6',
  component: 'M6 6h12v12H6zM9 2v4m6-4v4m-6 12v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4',
  module: 'M2 5h20v14H2zM5 9h5m-5 5h5m5-5h3m-3 5h3',
} satisfies Record<ComponentIconKey | 'component' | 'module', string>;

export function DeviceIcon({ iconKey = 'component' }: { iconKey?: keyof typeof symbols }) {
  return <svg className="v1-device-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={symbols[iconKey]} />
  </svg>;
}

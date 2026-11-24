import type { ReactNode } from 'react';
import type { ComponentDefinition, ComponentIconKey, ModuleDefinition } from '../../../model/v1/types';

export type DeviceIconKey = ComponentIconKey | 'component' | 'module' | 'enclosure';

const symbols = {
  laser: <path d="M1 15h5M6 10l8 5-8 5zM14 10v10M14 15h8M11 7l5-4m-3 0h3v3M17 8l5-4m-3 0h3v3" />,
  dml: <path d="M1 15h5M6 10l8 5-8 5zM14 10v10M14 15h8M11 7l5-4m-3 0h3v3M17 8l5-4m-3 0h3v3M1 5c1-3 2-3 3 0s2 3 3 0v5" />,
  multiWavelengthSource: <><rect x="3" y="5" width="14" height="15" rx="1" /><path d="M7 16v-5m5 5V8m5 5h6m-3-3 3 3-3 3" /></>,
  mzm: <path d="M1 13h3l5-5h6l5 5h3M4 13l5 5h6l5-5M9 4h6" />,
  photodiode: <path d="M1 15h5M6 10l8 5-8 5zM14 10v10M14 15h8M12 2 8 7m0-3v3h3M19 3l-4 5m0-3v3h3" />,
  opticalSwitch: <path d="M2 16h5m0 0 10-9m1 9h4M7 14v4m11-4v4" />,
  opticalAttenuator: <path d="M1 12h7m8 0h7M11 4 7 20h6l4-16zM10 12h4" />,
  amplifier: <path d="M1 12h5M6 4l13 8-13 8zM19 12h4" />,
  rfAttenuator: <><rect x="5" y="6" width="14" height="12" rx="1" /><path d="M1 12h4m14 0h4M9 12h6" /></>,
  dcSupply: <><circle cx="12" cy="12" r="8" /><path d="M1 12h3m16 0h3M8 7v5m-2.5-2.5h5M13 16h5" /></>,
  dcConverter: <><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M1 12h3m16 0h3M5 19 19 5M7 8h4m-4 3h2m5 5h4m-4 3h2" /></>,
  controlCircuit: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /></>,
  splitter: <path d="M1 12h7c5 0 6-7 11-7h4M8 12c5 0 6 7 11 7h4" />,
  sfp: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M5 9h12m-3-3 3 3-3 3m5 3H7m3-3-3 3 3 3" /></>,
  component: <><rect x="6" y="6" width="12" height="12" rx="1" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></>,
  module: <><rect x="2" y="4" width="20" height="16" rx="1" /><path d="M6 8h4v8H6zM14 8h4v8h-4z" /></>,
  enclosure: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M1 6v12M23 6v12M7 9h10M7 15h10" /></>,
} satisfies Record<DeviceIconKey, ReactNode>;

export function definitionIcon(definition: ComponentDefinition | ModuleDefinition): DeviceIconKey {
  if (definition.kind === 'module') return definition.physicalEnclosure ? 'enclosure' : 'module';
  return definition.iconKey ?? 'component';
}

export function DeviceIcon({ iconKey, size = 18 }: { iconKey: DeviceIconKey; size?: 16 | 18 }) {
  return <svg className="v1-device-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {symbols[iconKey]}
  </svg>;
}

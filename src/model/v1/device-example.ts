import type { OpticalChannelId } from './channels';
import type { NumericParameter } from './parameters';
import type { PortDefinition, Project } from './types';

const ch28 = 'DWDM_CH28', ch30 = 'DWDM_CH30';
const optical = (id: string, direction: PortDefinition['direction'], ...channelIds: OpticalChannelId[]): PortDefinition =>
  ({ id, type: 'OPTICAL', direction, channelIds });
const rf = (id: string, direction: PortDefinition['direction']): PortDefinition => ({ id, type: 'RF', direction });
const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const txGain: NumericParameter = {
  id: 'modulatorGain', name: 'Modulator gain', kind: 'numeric', unit: 'dB', valueKind: 'fixed',
  range: { min: -20, max: 0 }, defaultValue: fixed(-3), overridable: true,
};

export const deviceExample = {
  id: 'device-example', name: 'V1 device and parameter example', rootModuleDefinitionId: 'system',
  componentDefinitions: [
    {
      kind: 'component', id: 'rf-pcb', name: 'RF PCB',
      ports: [
        { ...rf('RF_IN', 'in'), inputRating: { unit: 'dBm', max: 10 } },
        rf('RF_OUT', 'out'), { id: 'CTRL', type: 'CONTROL', direction: 'in' },
      ],
      transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: {
        kind: 'rfCurve', points: [[0, 0], [67, -2]],
      } }],
    },
    {
      kind: 'component', id: 'mzm', name: 'Optically supplied MZM',
      ports: [rf('RF_IN', 'in'), optical('LASER_IN', 'in', ch30), optical('OPT_OUT', 'out', ch30)],
      parameters: [txGain],
      transfers: [{ kind: 'eo', fromPortId: 'RF_IN', toPortId: 'OPT_OUT', supplyPortId: 'LASER_IN',
        channelIds: [ch30], gainDb: { kind: 'parameter', parameterId: txGain.id } }],
    },
    {
      kind: 'component', id: 'pd850', name: '850 nm PD',
      ports: [optical('OPT_IN', 'in', 'MM850'), rf('RF_OUT', 'out')],
      transfers: [{ kind: 'oe', fromPortId: 'OPT_IN', toPortId: 'RF_OUT' }],
    },
    {
      kind: 'component', id: 'mux', name: 'CWDM/DWDM optical multiplexer',
      ports: [
        optical('IN_1371', 'in', 'CWDM_1371'), optical('IN_28', 'in', ch28), optical('IN_30', 'in', ch30),
        optical('COMMON', 'out', 'CWDM_1371', ch28, ch30),
      ],
      transfers: [
        { kind: 'optical', fromPortId: 'IN_1371', toPortId: 'COMMON', channelIds: ['CWDM_1371'] },
        { kind: 'optical', fromPortId: 'IN_28', toPortId: 'COMMON', channelIds: [ch28] },
        { kind: 'optical', fromPortId: 'IN_30', toPortId: 'COMMON', channelIds: [ch30] },
      ],
    },
    {
      kind: 'component', id: 'demux', name: 'DWDM optical demultiplexer',
      ports: [optical('COMMON', 'in', ch28, ch30), optical('OUT_28', 'out', ch28), optical('OUT_30', 'out', ch30)],
      transfers: [
        { kind: 'optical', fromPortId: 'COMMON', toPortId: 'OUT_28', channelIds: [ch28] },
        { kind: 'optical', fromPortId: 'COMMON', toPortId: 'OUT_30', channelIds: [ch30] },
      ],
    },
    {
      kind: 'component', id: 'switch', name: 'Optical 1×2 switch',
      ports: [optical('IN', 'in', ch28, ch30), optical('OUT_A', 'out', ch28, ch30), optical('OUT_B', 'out', ch28, ch30)],
      switchStates: [
        { id: 'a', name: 'Select A', routes: [{ fromPortId: 'IN', toPortId: 'OUT_A', gainDb: fixed(-1) }] },
        { id: 'b', name: 'Select B', routes: [{ fromPortId: 'IN', toPortId: 'OUT_B', gainDb: {
          kind: 'channelTable', values: { [ch28]: -1.2, [ch30]: -1.5 },
        } }] },
      ],
    },
  ],
  moduleDefinitions: [
    {
      kind: 'module', id: 'system', name: 'System', ports: [],
      instances: [
        { id: 'board', name: 'Transceiver board', definitionId: 'board',
          parameterOverrides: { modulatorGain: fixed(-4), mode: 'normal' } },
        { id: 'rf', name: 'RF PCB', definitionId: 'rf-pcb' },
        { id: 'mux', name: 'MUX', definitionId: 'mux' },
        { id: 'demux', name: 'DEMUX', definitionId: 'demux' },
        { id: 'swA', name: 'Switch A', definitionId: 'switch', switchStateId: 'a' },
        { id: 'swB', name: 'Switch B', definitionId: 'switch', switchStateId: 'b' },
      ],
    },
    {
      kind: 'module', id: 'board', name: 'Independent TX and RX board',
      ports: [optical('TX_OUT', 'out', ch30), optical('RX_IN', 'in', 'MM850')],
      parameters: [txGain, { kind: 'enum', id: 'mode', name: 'Board mode', options: ['normal', 'standby'],
        defaultValue: 'standby', overridable: true }],
      instances: [
        { id: 'TX_CH30', name: 'TX CH30', definitionId: 'tx30' },
        { id: 'RX_850', name: 'RX 850', definitionId: 'rx850' },
      ],
      portMappings: [
        { portId: 'TX_OUT', target: { instanceId: 'TX_CH30', portId: 'OUT' } },
        { portId: 'RX_IN', target: { instanceId: 'RX_850', portId: 'IN' } },
      ],
      parameterMappings: [{ parameterId: txGain.id, target: { instanceId: 'TX_CH30', parameterId: txGain.id } }],
    },
    {
      kind: 'module', id: 'tx30', name: 'CH30 transmitter', ports: [optical('OUT', 'out', ch30)],
      parameters: [txGain],
      instances: [{ id: 'mzm', name: 'MZM', definitionId: 'mzm' }],
      portMappings: [{ portId: 'OUT', target: { instanceId: 'mzm', portId: 'OPT_OUT' } }],
      parameterMappings: [{ parameterId: txGain.id, target: { instanceId: 'mzm', parameterId: txGain.id } }],
    },
    {
      kind: 'module', id: 'rx850', name: '850 nm receiver', ports: [optical('IN', 'in', 'MM850')],
      instances: [{ id: 'pd', name: '850 nm PD', definitionId: 'pd850' }],
      portMappings: [{ portId: 'IN', target: { instanceId: 'pd', portId: 'OPT_IN' } }],
    },
  ],
  conversionProfiles: [{
    id: 'measured-ch30', name: 'Example CH30 RF calibration', rfGainRefDb: fixed(-22), pdPowerRefDbm: -2,
    applicability: { channelIds: [ch30], notes: 'Representative reference condition for an MZM / PD pair' },
  }],
} satisfies Project;

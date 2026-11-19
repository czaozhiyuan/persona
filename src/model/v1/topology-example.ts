import type { OpticalChannelId } from './channels';
import type { NumericParameter } from './parameters';
import type { ConversionBinding } from './topology';
import type { PortDirection, Project } from './types';

const wdmChannels = ['DWDM_CH28', 'DWDM_CH30'] as const;
const optical = (id: string, direction: PortDirection, channelIds: readonly OpticalChannelId[] = wdmChannels) =>
  ({ id, type: 'OPTICAL' as const, direction, channelIds });
const rf = (id: string, direction: PortDirection) => ({ id, type: 'RF' as const, direction });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const operatingPointLoss: NumericParameter = {
  id: 'operatingPointLoss', name: '控制点附加损耗', kind: 'numeric', unit: 'dB', valueKind: 'fixed',
  range: { min: 0 }, defaultValue: { kind: 'fixed', value: 2 }, overridable: true,
};

const binding: ConversionBinding = {
  id: 'span-1',
  profileId: 'reference',
  eo: { instancePath: ['TX_A', 'mzm'], fromPortId: 'RF_IN', toPortId: 'OUT' },
  oe: { instancePath: ['RX_A', 'pd'], fromPortId: 'IN', toPortId: 'RF_OUT' },
  overrides: { k: 1.8 },
};

export const topologyExample = {
  id: 'topology-example', name: 'Incremental optical system', rootModuleDefinitionId: 'system',
  componentDefinitions: [
    { kind: 'component', id: 'rf-source', name: 'RF source', ports: [rf('OUT', 'out')] },
    {
      kind: 'component', id: 'mzm', name: 'MZM',
      ports: [rf('RF_IN', 'in'), optical('SUPPLY', 'in'), optical('OUT', 'out')],
      parameters: [operatingPointLoss],
      transfers: [{ kind: 'eo', fromPortId: 'RF_IN', toPortId: 'OUT', supplyPortId: 'SUPPLY', opticalLoss: {
        intrinsicLossDb: { kind: 'fixed', value: 3 },
        operatingPointLossDb: { kind: 'parameter', parameterId: operatingPointLoss.id },
      } }],
    },
    {
      kind: 'component', id: 'pd', name: 'PD',
      ports: [optical('IN', 'in'), rf('RF_OUT', 'out')],
      transfers: [{ kind: 'oe', fromPortId: 'IN', toPortId: 'RF_OUT' }],
    },
  ],
  moduleDefinitions: [
    {
      kind: 'module', id: 'system', name: 'System', ports: [],
      instances: [
        { id: 'TX_A', name: 'Transmitter A', definitionId: 'tx' },
        { id: 'TX_B', name: 'Transmitter B', definitionId: 'tx' },
        { id: 'RX_A', name: 'Receiver A', definitionId: 'rx' },
        { id: 'RX_B', name: 'Receiver B', definitionId: 'rx' },
      ],
      connections: [
        { id: 'spare', from: local('TX_B', 'OPT_OUT'), to: local('RX_B', 'OPT_IN'), mediaKind: 'OPTICAL_FIBER' },
        { id: 'control', from: local('TX_B', 'CONTROL_OUT'), to: local('RX_B', 'CONTROL_IN'), mediaKind: 'RJ45_CABLE' },
      ],
      cableBundles: [{
        id: 'mpo-12', coreCount: 12, cores: [
          { id: 'wdm', a: { pin: 1, endpoint: local('TX_A', 'OPT_OUT') }, b: { pin: 12, endpoint: local('RX_A', 'OPT_IN') } },
          { id: 'return', a: { pin: 2, endpoint: local('TX_A', 'RETURN_IN') }, b: { pin: 11, endpoint: local('RX_A', 'RETURN_OUT') } },
          { id: 'open', a: { pin: 3, endpoint: local('TX_A', 'TEST_OUT') }, b: { pin: 10 } },
        ],
      }],
    },
    {
      kind: 'module', id: 'tx', name: 'Transmitter chassis',
      ports: [
        optical('OPT_OUT', 'out'), optical('RETURN_IN', 'in'), optical('TEST_OUT', 'out', ['DWDM_CH28']),
        { id: 'CONTROL_OUT', type: 'CONTROL', direction: 'out' },
      ],
      instances: [
        { id: 'source', name: 'RF source', definitionId: 'rf-source' },
        { id: 'mzm', name: 'MZM', definitionId: 'mzm' },
      ],
      portMappings: [{ portId: 'OPT_OUT', target: local('mzm', 'OUT') }],
      parameters: [operatingPointLoss],
      parameterMappings: [{ parameterId: operatingPointLoss.id,
        target: { instanceId: 'mzm', parameterId: operatingPointLoss.id } }],
      connections: [{ id: 'rf-feed', from: local('source', 'OUT'), to: local('mzm', 'RF_IN'), mediaKind: 'RF_COAX' }],
    },
    {
      kind: 'module', id: 'rx', name: 'Receiver chassis awaiting internal mapping',
      ports: [
        optical('OPT_IN', 'in'), optical('RETURN_OUT', 'out'),
        optical('MM_IN', 'in', ['MM850']), { id: 'CONTROL_IN', type: 'CONTROL', direction: 'in' },
      ],
      instances: [{ id: 'pd', name: 'PD', definitionId: 'pd' }],
    },
  ],
  conversionProfiles: [{ id: 'reference', name: 'Reference', rfGainRefDb: { kind: 'fixed', value: -22 }, pdPowerRefDbm: -2 }],
  namedLinks: [
    { id: 'draft', name: 'Optical budget' },
    { id: 'tx-only', name: 'Optical budget', from: { instancePath: ['TX_A'], portId: 'OPT_OUT' } },
    {
      id: 'full', name: 'End-to-end budget', channelId: 'DWDM_CH28',
      from: { instancePath: ['TX_A', 'source'], portId: 'OUT' },
      to: { instancePath: ['RX_A', 'pd'], portId: 'RF_OUT' },
      via: [{ scopePath: ['TX_A'], connectionId: 'rf-feed' }, { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }],
      conversionBindings: [binding],
    },
    {
      id: 'wdm30', name: 'CH30 on the same core', channelId: 'DWDM_CH30',
      from: { instancePath: ['TX_A'], portId: 'OPT_OUT' }, to: { instancePath: ['RX_A'], portId: 'OPT_IN' },
      via: [{ scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }],
    },
  ],
} satisfies Project;

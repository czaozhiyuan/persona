import type { NumericParameter } from '../../model/v1/parameters';
import type { ComponentDefinition, ModuleDefinition, PortDefinition } from '../../model/v1/types';

const rfPorts: readonly PortDefinition[] = [
  { id: 'RF_IN', type: 'RF', direction: 'in' },
  { id: 'RF_OUT', type: 'RF', direction: 'out' },
];
const gain: NumericParameter = {
  id: 'gain', name: '增益', kind: 'numeric', unit: 'dB', valueKind: 'fixed', overridable: true,
};

export const builtInDefinitions = [
  {
    kind: 'component', id: 'library-rf-gain', name: 'RF 增益器件', ports: rfPorts,
    parameters: [{ ...gain, defaultValue: { kind: 'fixed', value: 6 } }],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: { kind: 'parameter', parameterId: 'gain' } }],
  },
  {
    kind: 'component', id: 'library-optical-source', name: '双通道光源', ports: [
      { id: 'OPT_OUT', type: 'OPTICAL', direction: 'out', channelIds: ['DWDM_CH28', 'DWDM_CH30'] },
    ],
  },
  {
    kind: 'module', id: 'library-rf-stage', name: 'RF 增益模块', ports: rfPorts, parameters: [gain],
    instances: [{ id: 'amplifier', name: '内部增益器件', definitionId: 'library-rf-gain' }],
    portMappings: rfPorts.map(port => ({ portId: port.id, target: { instanceId: 'amplifier', portId: port.id } })),
    parameterMappings: [{ parameterId: 'gain', target: { instanceId: 'amplifier', parameterId: 'gain' } }],
  },
] as const satisfies readonly (ComponentDefinition | ModuleDefinition)[];

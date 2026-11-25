import { builtInDefinitions } from '../../../src/library/v1/built-in';
import type { ComponentDefinition, ModuleDefinition, Project } from '../../../src/model/v1/types';

export function digitalControlProject(): Project {
  const sfp = structuredClone(builtInDefinitions.find(d => d.id === 'library-sfp')!) as ComponentDefinition;
  const controller: ComponentDefinition = { id: 'controller', name: '控制电路', kind: 'component', ports: [
    { id: 'out', name: 'TTL OUT', type: 'CONTROL', direction: 'out' },
    { id: 'in', name: 'TTL IN', type: 'CONTROL', direction: 'in' },
    { id: 'aux', name: 'AUX IN', type: 'CONTROL', direction: 'in' },
  ] };
  const local = (instanceId: string, portId: string) => ({ instanceId, portId });
  const ref = (id: string, portId: string) => ({ instancePath: [id], portId });
  const ports = sfp.ports.filter(p => p.type !== 'DC_POWER').map(({ id, name, type, direction }) => ({ id, name, type, direction }));
  const box: ModuleDefinition = { id: 'box', name: '机箱', kind: 'module', ports,
    instances: [{ id: 'sfp', definitionId: sfp.id, name: '收发器' }],
    portMappings: ports.map(p => ({ portId: p.id, target: local('sfp', p.id) })) };
  const directions = [['a', 'b'], ['b', 'a']] as const;
  const root: ModuleDefinition = { id: 'root', name: '系统', kind: 'module', ports: [],
    instances: directions.flatMap(([id]) => [{ id, definitionId: 'box', name: '机箱 ' + id },
      { id: 'ctl-' + id, definitionId: controller.id, name: '控制 ' + id }]),
    connections: [...directions.flatMap(([id]) => [
      { id: 'tx-' + id, from: local('ctl-' + id, 'out'), to: local(id, 'DATA_TX_IN') },
      { id: 'rx-' + id, from: local(id, 'DATA_RX_OUT'), to: local('ctl-' + id, 'in') }]),
      { id: 'pure', from: local('ctl-a', 'out'), to: local('ctl-b', 'aux') }],
    cableBundles: [{ id: 'mpo', coreCount: 12, cores: directions.map(([tx, rx], i) => ({
      id: tx + rx, lossDb: i ? 1 : 3, a: { pin: i + 1, endpoint: local(tx, 'OPT_TX_OUT') },
      b: { pin: i + 1, endpoint: local(rx, 'OPT_RX_IN') } })) }] };
  return { id: 'control-link', name: '数字光链路', rootModuleDefinitionId: root.id,
    componentDefinitions: [controller, sfp], moduleDefinitions: [root, box],
    namedLinks: [...directions.map(([tx, rx]) => ({ id: tx + rx, name: tx + ' → ' + rx,
      from: ref('ctl-' + tx, 'out'), to: ref('ctl-' + rx, 'in'), channelId: 'MM850' as const,
      trial: { frequencyGHz: 1 } })),
      { id: 'pure', name: '控制直连', from: ref('ctl-a', 'out'), to: ref('ctl-b', 'aux') }],
    layout: { topology: ['ctl-a', 'a', 'b', 'ctl-b'].map((id, i) => ({ instancePath: [id], x: 100 + i * 460, y: 250 })) } };
}

import { builtInDefinitions } from '../../../src/library/v1/built-in';
import type { ComponentDefinition, ModuleDefinition, PortDefinition, Project } from '../../../src/model/v1/types';
import { withWdmPorts } from '../../../src/model/v1/wdm';

const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const slot = (id: string, definitionId: string) => ({ id, name: id, definitionId });
const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition => ({ id, type, direction });
const wire = (id: string, from: ReturnType<typeof local>, to: ReturnType<typeof local>) => ({ id, from, to });

export function nestedDigitalProject(): Project {
  const controller: ComponentDefinition = { kind: 'component', id: 'logic', name: '控制电路', ports: [
    port('TTL OUT', 'CONTROL', 'out'), port('TTL IN', 'CONTROL', 'in'), port('aux', 'CONTROL', 'out'),
    port('rf', 'RF', 'in'), port('opt', 'OPTICAL', 'out'), port('dc', 'DC_POWER', 'in'), port('ac', 'AC_POWER', 'in'),
  ] };
  const converter: ComponentDefinition = { kind: 'component', id: 'custom', name: '接口', ports: [
    port('a', 'CONTROL', 'in'), port('b', 'OPTICAL', 'out'), port('c', 'OPTICAL', 'in'), port('d', 'CONTROL', 'out'),
  ], transfers: [{ kind: 'digitalTx', fromPortId: 'a', toPortId: 'b' }, { kind: 'digitalRx', fromPortId: 'c', toPortId: 'd' }] };
  const adapter: ModuleDefinition = { kind: 'module', id: 'adapter', name: '接口板', ports: converter.ports,
    instances: [slot('device', 'custom')], portMappings: converter.ports.map(p => ({ portId: p.id, target: local('device', p.id) })) };
  const card: ModuleDefinition = { kind: 'module', id: 'card', name: '插盒', ports: adapter.ports,
    instances: [slot('ctl', 'logic'), slot('io', 'adapter')],
    connections: [wire('drive', local('ctl', 'TTL OUT'), local('io', 'a')), wire('receive', local('io', 'd'), local('ctl', 'TTL IN'))],
    portMappings: adapter.ports.map(p => ({ portId: p.id, target: local('io', p.id) })) };
  const wdm = builtInDefinitions.find(d => d.id === 'library-wdm')! as ComponentDefinition;
  const reverse = withWdmPorts({ ...wdm, id: 'reverse' }, wdm.ports.map(p => p.id === 'COM' ? p
    : { ...p, direction: p.direction === 'in' ? 'out' : 'in' }));
  function box(id: string, filter: ComponentDefinition, tx: string, rx: string): ModuleDefinition {
    return { kind: 'module', id, name: id, ports: [port('COM', 'OPTICAL', 'bidirectional')],
      instances: [slot('card', card.id), slot('wdm', filter.id)],
      portMappings: [{ portId: 'COM', target: local('wdm', 'COM') }],
      connections: [wire('launch', local('card', 'b'), local('wdm', tx)), wire('detect', local('wdm', rx), local('card', 'c'))] };
  }
  const root: ModuleDefinition = { kind: 'module', id: 'root', name: '系统', ports: [],
    instances: [slot('A', 'A'), slot('B', 'B')], connections: [wire('fibre', local('A', 'COM'), local('B', 'COM'))] };
  return { id: 'nested', name: '双向数字传输', rootModuleDefinitionId: 'root',
    componentDefinitions: [controller, converter, wdm, reverse],
    moduleDefinitions: [root, box('A', wdm, 'CH1', 'CH3'), box('B', reverse, 'CH3', 'CH1'), card, adapter] };
}

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

export const sharedChannel = 'CWDM_1311' as const;
export const inputs = ['red', 'green', 'blue'];
export const outputs = ['right', 'left', 'middle'];
export const controlPin = (box: string, portId: string) => ({ instancePath: [box, 'card', 'ctl'], portId });

export function sharedDigitalProject(): Project {
  const project = nestedDigitalProject();
  const [logic, , wdm, reverse] = project.componentDefinitions;
  const [root, , , , adapter] = project.moduleDefinitions;
  logic.controlRouting = true;
  logic.ports = [
    { ...port('TTL OUT', 'CONTROL', 'out'), name: 'CML TX' }, { ...port('TTL IN', 'CONTROL', 'in'), name: 'CML RX' },
    ...inputs.map((id, i) => ({ ...port(id, 'CONTROL', 'in'), name: 'RS422 RX' + (i + 1) })),
    ...outputs.map((id, i) => ({ ...port(id, 'CONTROL', 'out'), name: 'RS422 TX' + (i + 1) })),
  ];
  logic.transfers = [
    ...inputs.map(id => ({ kind: 'control' as const, fromPortId: id, toPortId: 'TTL OUT' })),
    ...outputs.map(id => ({ kind: 'control' as const, fromPortId: 'TTL IN', toPortId: id })),
  ];
  const sfp = builtInDefinitions.find(d => d.id === 'library-sfp')! as ComponentDefinition;
  project.componentDefinitions = [logic, sfp, wdm, reverse];
  adapter.instances = [slot('device', sfp.id)];
  adapter.portMappings = Object.entries({ a: 'DATA_TX_IN', b: 'OPT_TX_OUT', c: 'OPT_RX_IN', d: 'DATA_RX_OUT' })
    .map(([portId, pin]) => ({ portId, target: local('device', pin) }));
  root.connections = root.connections!.map(c => ({ ...c, lossDb: 3 }));
  project.instanceSettings = ['A', 'B'].map(box => ({ instancePath: [box, 'wdm'],
    parameterOverrides: { insertionLoss: { kind: 'fixed', value: 0 } } }));
  project.namedLinks = inputs.map((id, i) => ({ id: 'link-' + i, name: '业务 ' + (i + 1),
    from: controlPin('A', id), to: controlPin('B', outputs[i]), channelId: sharedChannel }));
  return project;
}

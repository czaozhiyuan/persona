import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasEdgeKey, projectPathHighlight } from '../../src/editors/topology/v1/path-highlight';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { signalPortKey } from '../../src/engine/v1/signal-graph';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import type { ComponentDefinition, ModuleDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { topologyExample } from '../../src/model/v1/topology-example';
import { editModule } from '../../src/state/v1/topology-edits';
import { createEndpointChoices } from '../../src/workbench/v1/links/link-endpoints';
import { createLinkOptions, requiredEdgeKey } from '../../src/workbench/v1/links/link-options';
import { nestedDigitalProject } from './fixtures/nested-digital-project';

test('Link choices distinguish reused scoped records, half-open cores, and EO/OE instance boundaries', () => {
  const options = createLinkOptions(topologyExample);
  assert.deepEqual(options.via.filter(item => 'connectionId' in item.value && item.value.connectionId === 'rf-feed')
    .map(item => item.key), [requiredEdgeKey({ scopePath: ['TX_A'], connectionId: 'rf-feed' }),
    requiredEdgeKey({ scopePath: ['TX_B'], connectionId: 'rf-feed' })]);
  assert.match(options.via.find(item => 'coreId' in item.value && item.value.coreId === 'open')?.label ?? '', /未接全/);
  assert.deepEqual(options.eo.map(item => item.value.instancePath), [['TX_A', 'mzm'], ['TX_B', 'mzm']]);
  assert.deepEqual(options.oe.map(item => item.value.instancePath), [['RX_A', 'pd'], ['RX_B', 'pd']]);
});

test('path projection shows the active fibre and mapping only in their actual occurrence scope', () => {
  const link = topologyExample.namedLinks.find(item => item.id === 'full')!;
  const missing = createLinkOptions(topologyExample).resolveNamedLink(link);
  assert.equal(missing.status, 'incomplete');
  assert.ok(projectPathHighlight(missing, []).ports.has(signalPortKey({ instancePath: ['RX_A'], portId: 'OPT_IN' })));
  const mapped = editModule(topologyExample, 'rx', module => ({
    ...module, portMappings: [{ portId: 'OPT_IN', target: { instanceId: 'pd', portId: 'IN' } }],
  }));
  const result = createLinkOptions(mapped).resolveNamedLink(link);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.trace?.supplies[0].status, 'missing');
  const root = projectPathHighlight(result, []);
  assert.deepEqual([...root.edges], [canvasEdgeKey('core', 'mpo-12', 'wdm')]);
  assert.deepEqual([...root.folded], ['TX_A', 'RX_A']);
  assert.deepEqual([...projectPathHighlight(result, ['TX_A']).edges],
    [canvasEdgeKey('connection', 'rf-feed'), canvasEdgeKey('mapping', 'OPT_OUT')]);
  assert.equal(projectPathHighlight(result, ['TX_B']).edges.size, 0);
});

const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const ref = (portId: string, ...instancePath: string[]) => ({ instancePath, portId });
const wire = (id: string, from: ReturnType<typeof local>, to: ReturnType<typeof local>) => ({ id, from, to });
const slot = (id: string, definitionId: string) => ({ id, name: definitionId, definitionId });
const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition => ({ id, type, direction });
const component = (id: string) => builtInDefinitions.find(item => item.id === 'library-' + id)! as ComponentDefinition;

test('three independent RF/optical chains use their outermost mapped boundaries and their physical fibre', () => {
  const rfIn = port('a', 'RF', 'in'), rfOut = port('b', 'RF', 'out');
  const tx = (model: string): ModuleDefinition => ({
    kind: 'module', id: model, name: model, ports: [rfIn, port('b', 'OPTICAL', 'out'), port('ac', 'AC_POWER', 'in')],
    instances: [slot('stage', component(model).id)], portMappings: [
      { portId: 'a', target: local('stage', 'RF_IN') }, { portId: 'b', target: local('stage', 'OPT_OUT') },
    ],
  });
  const chains = ['1', '2', '3'];
  const root: ModuleDefinition = { kind: 'module', id: 'root', name: 'System', ports: [],
    instances: chains.flatMap(i => [slot('t' + i, i === '1' ? 'mzm' : 'dml'), slot('r' + i, 'rx')]),
    connections: chains.slice(1).map(i => wire(i, local('t' + i, 'b'), local('r' + i, 'a'))),
    cableBundles: [{ id: 'mpo', coreCount: 1, cores: [{ id: 'pair', a: { pin: 1, endpoint: local('t1', 'b') },
      b: { pin: 1, endpoint: local('r1', 'a') } }] }],
  };
  const project: Project = { id: 'test', name: 'Test', rootModuleDefinitionId: root.id,
    componentDefinitions: ['mzm', 'dml', 'pd', 'rf-gain'].map(component),
    moduleDefinitions: [root, tx('mzm'), tx('dml'), { kind: 'module', id: 'rx', name: 'Rx',
      ports: [port('a', 'OPTICAL', 'in'), rfOut], instances: [slot('pd', 'library-pd'), slot('amp', 'library-rf-gain')],
      connections: [wire('rf', local('pd', 'RF_OUT'), local('amp', 'RF_IN'))],
      portMappings: [{ portId: 'a', target: local('pd', 'OPT_IN') }, { portId: 'b', target: local('amp', 'RF_OUT') }] }] };
  const options = createLinkOptions(project);
  const starts = chains.map(i => ref('a', 't' + i)), ends = chains.map(i => ref('b', 'r' + i));
  const initial = options.endpointChoices('', undefined, false);
  assert.deepEqual(initial.from.map(o => o.value), starts);
  assert.deepEqual(initial.to.map(o => o.value), ends);
  for (const [i, start] of starts.entries()) {
    const { from, to } = options.endpointChoices(signalPortKey(start), undefined, false);
    assert.deepEqual(from.map(o => o.value), starts);
    assert.deepEqual(to.map(o => o.value), [ends[i]]);
  }
  const localChoices = options.endpointChoices(signalPortKey(starts[0]), undefined, true);
  assert.deepEqual(localChoices.from, localChoices.to);
  assert.ok(localChoices.from.some(o => o.key === signalPortKey(ref('OPT_OUT', 't1', 'stage'))));
  assert.ok(localChoices.from.every(o => !options.graph.ports.get(o.key)?.definition.type.endsWith('POWER')));
  const mapped = editModule(project, 'root', module => ({ ...module, ports: [rfIn, rfOut],
    portMappings: [{ portId: 'a', target: local('t2', 'a') }, { portId: 'b', target: local('r2', 'b') }] }));
  const outer = createLinkOptions(mapped).endpointChoices(signalPortKey(ref('a')), undefined, false);
  assert.deepEqual(outer.from.map(o => o.value), [ref('a'), starts[0], starts[2]]);
  assert.deepEqual(outer.to.map(o => o.value), [ref('b')]);
});

test('CONTROL sources and terminal inputs follow SFP, switch, channel and bidirectional dark splitter routes', () => {
  const controller: ComponentDefinition = { kind: 'component', id: 'ctl', name: 'Controller',
    ports: [port('send', 'CONTROL', 'out'), port('receive', 'CONTROL', 'in')] };
  const project: Project = { id: 'test', name: 'Test', rootModuleDefinitionId: 'root',
    componentDefinitions: [controller, ...['sfp', 'optical-switch', 'splitter', 'laser'].map(component)],
    moduleDefinitions: [{ kind: 'module', id: 'root', name: 'System', ports: [],
      instances: [slot('a', 'ctl'), slot('b', 'ctl'), slot('tx', 'library-sfp'), slot('rx', 'library-sfp'),
        { ...slot('sw', 'library-optical-switch'), switchStateId: 'pass' }, slot('sp', 'library-splitter'), slot('source', 'library-laser')],
      connections: [wire('drive', local('a', 'send'), local('tx', 'DATA_TX_IN')),
        wire('fibre', local('tx', 'OPT_TX_OUT'), local('sw', 'OPT_IN')),
        wire('launch', local('sw', 'OPT_OUT'), local('sp', 'OPT_IN')),
        wire('dark', local('sp', 'OPT_OUT_1'), local('rx', 'OPT_RX_IN')),
        wire('data', local('rx', 'DATA_RX_OUT'), local('b', 'receive'))] }],
    instanceSettings: [{ instancePath: ['sp'], parameterOverrides: { firstPercent: { kind: 'fixed', value: 0 } } }],
  };
  const filtered = { ...project, componentDefinitions: project.componentDefinitions.map(d => d.id !== 'library-sfp' ? d : {
    ...d, ports: d.ports.map(p => p.type === 'OPTICAL' ? { ...p, channelIds: ['DWDM_CH28' as const] } : p),
  }) };
  const key = signalPortKey(ref('send', 'a')), sink = signalPortKey(ref('receive', 'b'));
  const options = createLinkOptions(filtered);
  const choices = options.endpointChoices(key, undefined, false);
  assert.ok(choices.from.some(o => o.key === key));
  assert.ok(choices.from.some(o => o.key === signalPortKey(ref('OPT_OUT', 'source'))));
  assert.ok(!choices.from.some(o => o.key === signalPortKey(ref('OPT_TX_OUT', 'tx'))));
  assert.ok(choices.to.some(o => o.key === sink));
  assert.ok(!choices.to.some(o => o.key === signalPortKey(ref('OPT_IN', 'sp'))));
  assert.equal(options.endpointChoices(key, 'DWDM_CH30', false).to.length, 0);
  const blocked = createLinkOptions({ ...filtered, instanceSettings: [
    ...filtered.instanceSettings!, { instancePath: ['sw'], switchStateId: 'block' }] });
  assert.equal(blocked.endpointChoices(key, undefined, false).to.length, 0);
  const cut = editModule(filtered, 'root', m => ({ ...m, connections: m.connections?.filter(c => c.id !== 'fibre') }));
  assert.ok(!createLinkOptions(cut).endpointChoices(key, undefined, false).to.some(o => o.key === sink));
});

test('ambiguous RF routes remain eligible and an exhausted search keeps the unconfirmed system ends', () => {
  const amp = component('rf-gain');
  const project: Project = { id: 'rf', name: 'RF', rootModuleDefinitionId: 'root', componentDefinitions: [amp],
    moduleDefinitions: [{ kind: 'module', id: 'root', name: 'System', ports: [],
      instances: ['input', 'a', 'b', 'output', 'isolated'].map(id => slot(id, amp.id)),
      connections: ['a', 'b'].flatMap(id => [wire('to-' + id, local('input', 'RF_OUT'), local(id, 'RF_IN')),
        wire('from-' + id, local(id, 'RF_OUT'), local('output', 'RF_IN'))]) }] };
  const from = ref('RF_IN', 'input'), to = ref('RF_OUT', 'output');
  const options = createLinkOptions(project);
  assert.equal(options.resolveNamedLink({ id: 'rf', name: 'RF', from, to }).status, 'ambiguous');
  assert.deepEqual(options.endpointChoices(signalPortKey(from), undefined, false).to.map(o => o.value), [to]);
  const limited = createEndpointChoices({ ...createPathResolver(project), reachableFrom: () => undefined }, options.endpoints);
  const choices = limited(signalPortKey(from), undefined, false);
  assert.equal(choices.limited, true);
  assert.deepEqual(choices.to.map(o => o.value), [to, ref('RF_OUT', 'isolated')]);
});

test('nested digital controllers remain boundaries when the WDM span changes and only the reachable peer is offered', () => {
  const project = nestedDigitalProject();
  const starts = ['A', 'B'].map(box => ref('TTL OUT', box, 'card', 'ctl'));
  const ends = ['A', 'B'].map(box => ref('TTL IN', box, 'card', 'ctl'));
  const options = createLinkOptions(project);
  const initial = options.endpointChoices('', undefined, false);
  assert.deepEqual(initial.from.map(o => o.value), starts);
  assert.deepEqual(initial.to.map(o => o.value), ends);
  for (const [i, start] of starts.entries()) {
    const peer = ends[1 - i];
    assert.deepEqual(options.endpointChoices(signalPortKey(start), undefined, false).to.map(o => o.value), [peer]);
    assert.equal(options.resolveNamedLink({ id: 'route', name: '离散线', from: start, to: peer }).status, 'resolved');
  }
  const key = signalPortKey(starts[0]);
  assert.deepEqual(options.endpointChoices(key, 'CWDM_1371', false).to, []);
  assert.deepEqual(options.endpointChoices(key, 'CWDM_1311', false).to.map(o => o.value), [ends[1]]);
  const cut = createLinkOptions(editModule(project, 'root', m => ({ ...m, connections: [] })));
  assert.deepEqual(cut.endpointChoices('', undefined, false).to.filter(o => o.value.portId === 'TTL IN').map(o => o.value), ends);
  assert.ok(cut.endpointChoices(key, undefined, false).from.some(o => o.key === key));
  assert.ok(!cut.endpointChoices(key, undefined, false).to.some(o => o.key === signalPortKey(ends[1])));
  assert.equal(cut.resolveNamedLink({ id: 'cut', name: '断路', from: starts[0], to: ends[1] }).status, 'unreachable');
  const localPorts = options.endpointChoices(key, undefined, true).to.map(o => o.value);
  assert.ok(localPorts.some(o => o.portId === 'a' && o.instancePath.length === 4));
  assert.ok(localPorts.some(o => o.portId === 'aux'));
  assert.ok(localPorts.every(o => o.portId !== 'dc' && o.portId !== 'ac'));
});

test('external CONTROL mappings take precedence only for the digital transfer and instance they expose', () => {
  let project = nestedDigitalProject();
  for (const [id, pin, direction] of [['A', 'a', 'in'], ['B', 'd', 'out']] as const) {
    project = editModule(project, id, m => ({ ...m, ports: [...m.ports, port(pin, 'CONTROL', direction)],
      portMappings: [...m.portMappings!, { portId: pin, target: local('card', pin) }] }));
  }
  const start = ref('a', 'A'), end = ref('d', 'B'), otherStart = ref('TTL OUT', 'B', 'card', 'ctl');
  const otherEnd = ref('TTL IN', 'A', 'card', 'ctl');
  const options = createLinkOptions(project);
  const initial = options.endpointChoices('', undefined, false);
  assert.deepEqual(initial.from.map(o => o.value), [start, otherStart]);
  assert.deepEqual(initial.to.map(o => o.value), [otherEnd, end]);
  assert.deepEqual(options.endpointChoices(signalPortKey(start), undefined, false).to.map(o => o.value), [end]);
  const root = createLinkOptions(editModule(project, 'root', m => ({ ...m, ports: [port('i', 'CONTROL', 'in'), port('o', 'CONTROL', 'out')],
    portMappings: [{ portId: 'i', target: local('A', 'a') }, { portId: 'o', target: local('B', 'd') }] })));
  assert.deepEqual(root.endpointChoices('', undefined, false).from.map(o => o.value), [ref('i'), otherStart]);
  assert.deepEqual(root.endpointChoices('', undefined, false).to.map(o => o.value), [ref('o'), otherEnd]);
  assert.deepEqual(root.endpointChoices(signalPortKey(ref('i')), undefined, false).to.map(o => o.value), [ref('o')]);
});

test('connected CONTROL aliases route through the hierarchy without becoming source or terminal choices', () => {
  const base = nestedDigitalProject();
  const logicPorts = [port('TTL OUT', 'CONTROL', 'out'), port('TTL IN', 'CONTROL', 'in')];
  const board: ModuleDefinition = { kind: 'module', id: 'board', name: '控制板', ports: logicPorts, instances: [slot('logic', 'logic')],
    portMappings: logicPorts.map(p => ({ portId: p.id, target: local('logic', p.id) })) };
  const project = editModule({ ...base, moduleDefinitions: [...base.moduleDefinitions, board] }, 'card', m => ({ ...m,
    instances: [slot('ctl', board.id), slot('io', 'adapter'), slot('relay', 'adapter')],
    connections: [...m.connections!, wire('cascade', local('io', 'd'), local('relay', 'a'))] }));
  const options = createLinkOptions(project), initial = options.endpointChoices('', undefined, false);
  const sends = ['A', 'B'].map(id => ref('TTL OUT', id, 'card', 'ctl', 'logic'));
  const receives = ['A', 'B'].map(id => ref('TTL IN', id, 'card', 'ctl', 'logic'));
  assert.deepEqual(initial.from.map(o => o.value), sends);
  assert.deepEqual(initial.to.map(o => o.value), receives);
  assert.deepEqual(options.endpointChoices(signalPortKey(sends[1]), undefined, false).to.map(o => o.value), [receives[0]]);
});

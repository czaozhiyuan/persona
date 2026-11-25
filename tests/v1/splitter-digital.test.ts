import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSignalGraph, isDigitalEdge } from '../../src/engine/v1/signal-graph';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { createConversionBudget } from '../../src/engine/v1/conversion-budget';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { linkAnnotations } from '../../src/editors/topology/v1/link-annotations';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import { factoryLibrary, parseLibrary, saveDefinition } from '../../src/library/v1/user-library';
import type { ComponentDefinition, Project } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { digitalControlProject } from './fixtures/digital-control-project';
import { canvasEdgeKey, projectPathHighlight } from '../../src/editors/topology/v1/path-highlight';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const endpoint = (instance: string, portId: string) => ({ instancePath: [instance], portId });
const wire = (id: string, a: string, out: string, b: string, input: string) =>
  ({ id, from: { instanceId: a, portId: out }, to: { instanceId: b, portId: input } });
const channel = 'DWDM_CH28' as const;
function opticalNetwork(percent = 50, loss = 0, missing = false): Project {
  const defs = ['library-sfp','library-splitter','library-pd','library-pcb'].map(id =>
    builtInDefinitions.find(d => d.id === id)! as ComponentDefinition);
  if (missing) defs[0] = { ...defs[0], parameters: defs[0].parameters?.map(p => ({ ...p, defaultValue: undefined })) };
  return { id: 'network', name: '数字光与分光', rootModuleDefinitionId: 'root', componentDefinitions: defs,
    moduleDefinitions: [{ kind: 'module', id: 'root', name: '系统', ports: [],
      instances: [['a', 'SFP A', defs[0].id], ['b', 'SFP B', defs[0].id], ['split', '光分路器', defs[1].id],
        ['pd', '监测 PD', defs[2].id], ['ctl', '控制电路', defs[3].id]].map(([id, name, definitionId]) => ({ id, name, definitionId })),
      connections: [wire('launch','a','OPT_TX_OUT','split','OPT_IN'), wire('first','split','OPT_OUT_1','b','OPT_RX_IN'),
        wire('second','split','OPT_OUT_2','pd','OPT_IN'), wire('return','b','OPT_TX_OUT','a','OPT_RX_IN')] }],
    namedLinks: [
      { id: 'forward', name: '数字 A → B', from: endpoint('a','DATA_TX_IN'), to: endpoint('b','DATA_RX_OUT'), channelId: channel },
      { id: 'reverse', name: '数字 B → A', from: endpoint('b','DATA_TX_IN'), to: endpoint('a','DATA_RX_OUT'), channelId: channel },
      { id: 'monitor', name: '光监测支路', from: endpoint('a','OPT_TX_OUT'), to: endpoint('pd','OPT_IN'), channelId: channel },
    ], instanceSettings: [
      { instancePath: ['a'], parameterOverrides: missing ? {} : { power: fixed(0), sensitivity: fixed(-15), overload: fixed(-5) } },
      { instancePath: ['b'], parameterOverrides: missing ? {} : { power: fixed(-2), sensitivity: fixed(-11), overload: fixed(0) } },
      { instancePath: ['split'], parameterOverrides: { firstPercent: fixed(percent), loss: fixed(loss) } },
      { instancePath: ['pd'], parameterOverrides: { receiver: 'external50', responsivity: fixed(0.8) } },
    ] };
}
function number(metric: BudgetMetric) { assert.equal(metric.availability,'available'); return metric.value; }
function near(actual: number, expected: number) {
  assert.ok(actual === expected || Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('broken digital links expose only established control access and discriminate channel, mapping and route failures', () => {
  const p = digitalControlProject(), [root, box] = p.moduleDefinitions, link = p.namedLinks![0];
  const core = root.cableBundles![0].cores[0];
  const original = core.b.endpoint;
  delete core.b.endpoint;
  const resolve = () => createPathResolver(p).resolveNamedLink(link);
  const broken = resolve();
  assert.equal(broken.status, 'unreachable');
  assert.equal(broken.trace, undefined);
  assert.deepEqual(projectPathHighlight(broken, []).edges, new Set([canvasEdgeKey('connection', 'tx-a'), canvasEdgeKey('connection', 'rx-b')]));
  assert.deepEqual(projectPathHighlight(broken, ['a']).edges, new Set([canvasEdgeKey('mapping','DATA_TX_IN')]));
  assert.deepEqual(projectPathHighlight(broken, ['b']).edges, new Set([canvasEdgeKey('mapping','DATA_RX_OUT')]));
  core.b.endpoint = original;
  const pure = createPathResolver(p).resolveNamedLink(p.namedLinks![2]);
  assert.equal(pure.status, 'resolved');
  assert.ok(pure.trace.steps.every(s => s.port.definition.type === 'CONTROL'));
  const sfp = p.componentDefinitions[1];
  sfp.ports = sfp.ports.map(port => port.type === 'OPTICAL' ? { ...port, channelIds: ['DWDM_CH28'] } : port);
  const mismatch = resolve();
  assert.equal(mismatch.status, 'unreachable'); assert.match(mismatch.reason, /光通道/);
  link.channelId = 'DWDM_CH28';
  const mappings = box.portMappings!;
  box.portMappings = mappings.filter(m => m.portId !== 'OPT_RX_IN');
  const open = resolve();
  assert.equal(open.status, 'incomplete'); assert.match(open.reason, /映射/);
  box.portMappings = mappings;
  root.connections = [...root.connections!, wire('second-rx-a','b','DATA_RX_OUT','ctl-b','aux')];
  const competing = createPathResolver(p).resolveNamedLink({ ...link, to: endpoint('ctl-b','aux') });
  assert.equal(competing.status, 'ambiguous');
  assert.equal(competing.trace, undefined);
  link.via = [{ scopePath: [], bundleId: 'mpo', coreId: 'ab' }];
  const saved = parseProjectJson(serializeProjectJson(p));
  assert.deepEqual(saved.namedLinks, p.namedLinks);
  assert.equal(createPathResolver(saved).resolveNamedLink({ ...saved.namedLinks![0], to: endpoint('ctl-b','aux') }).status, 'resolved');
});

test('an open control wire keeps the confirmed digital route up to the break from either side', () => {
  for (const broken of ['rx-b', 'tx-a']) {
    const p = digitalControlProject(), root = p.moduleDefinitions[0], link = p.namedLinks![0];
    root.connections = root.connections!.filter(c => c.id !== broken);
    const knownWire = canvasEdgeKey('connection', broken === 'rx-b' ? 'tx-a' : 'rx-b');
    const core = canvasEdgeKey('core', 'mpo', 'ab');
    link.via = [{ scopePath: [], bundleId: 'mpo', coreId: 'ab' }];
    const checkSelected = () => {
      const result = createPathResolver(p).resolveNamedLink(link);
      assert.equal(result.status, 'unreachable');
      assert.equal(result.trace, undefined);
      assert.deepEqual(projectPathHighlight(result, []).edges, new Set([knownWire, core]));
      for (const [box, ...ports] of [['a', 'DATA_TX_IN', 'OPT_TX_OUT'], ['b', 'OPT_RX_IN', 'DATA_RX_OUT']]) {
        assert.deepEqual(projectPathHighlight(result, [box]).edges, new Set(ports.map(id => canvasEdgeKey('mapping', id))));
      }
      assert.deepEqual(result.digitalAccess!.filter(isDigitalEdge).map(e => e.from.ref.instancePath[0]).sort(), ['a', 'b']);
    };
    checkSelected();
    const mismatched = createPathResolver(p).resolveNamedLink(link, {
      opticalSources: [{ instancePath: ['a', 'sfp'], portId: 'OPT_TX_OUT', channelId: 'DWDM_CH28' }],
    });
    assert.equal(mismatched.status, 'unreachable');
    assert.deepEqual(mismatched.digitalAccess!.filter(isDigitalEdge).map(e => e.from.ref.instancePath[0]), [broken === 'rx-b' ? 'a' : 'b']);
    root.instances = [...root.instances, { id: 'c', name: 'C', definitionId: 'box' }];
    root.connections = [...root.connections, broken === 'rx-b'
      ? wire('fork', 'a', 'OPT_TX_OUT', 'c', 'OPT_RX_IN') : wire('fork', 'c', 'OPT_TX_OUT', 'b', 'OPT_RX_IN')];
    checkSelected();
    const ambiguous = createPathResolver(p).resolveNamedLink({ ...link, via: [] });
    assert.equal(ambiguous.status, 'unreachable');
    assert.deepEqual(projectPathHighlight(ambiguous, []).edges, new Set([knownWire]));
    const box = broken === 'rx-b' ? 'a' : 'b';
    assert.deepEqual(projectPathHighlight(ambiguous, [box]).edges, new Set((box === 'a'
      ? ['DATA_TX_IN', 'OPT_TX_OUT'] : ['OPT_RX_IN', 'DATA_RX_OUT']).map(id => canvasEdgeKey('mapping', id))));
    assert.deepEqual(ambiguous.digitalAccess!.filter(isDigitalEdge).map(e => e.from.ref.instancePath[0]), [box]);
  }
});

test('digital receiver captions follow only the selected split branch, retaining dark, missing and overloaded states', () => {
  for (const [percent, missing, linkIndex, text] of [[0,false,0,'无光 · 低于灵敏度'], [50,true,0,'接收余量 不可用'],
    [50,false,1,'超过过载上限']] as const) {
    const p = opticalNetwork(percent, 0, missing), link = p.namedLinks![linkIndex];
    const resolver = createPathResolver(p), path = resolver.resolveNamedLink(link);
    assert.equal(path.status, 'resolved');
    const optics = createOpticalBudget(p).calculateDigitalPath(path.trace, link.channelId)!;
    const notes = linkAnnotations(resolver.graph, path, undefined, optics).nodes;
    assert.ok(notes.get(JSON.stringify(link.to!.instancePath))!.some(n => n.text.includes(text)));
    assert.ok(!notes.has(JSON.stringify(['pd'])));
    if (missing) assert.ok(notes.get(JSON.stringify(link.from!.instancePath))!.some(n => n.text === '光出 功率未设置'));
    if (percent === 0) assert.ok(notes.get(JSON.stringify(['b']))!.some(n => n.text === '光入 −∞ dBm'));
  }
  const p = opticalNetwork(75), root = p.moduleDefinitions[0], link = p.namedLinks![0];
  root.instances = [...root.instances, { id: 'c', definitionId: 'library-sfp', name: '另一个接收端' }];
  root.connections = root.connections!.map(c => c.id === 'second' ? { ...c, to: { instanceId: 'c', portId: 'OPT_RX_IN' } } : c);
  const resolver = createPathResolver(p);
  for (const [id, branch, share] of [['b','first',.75], ['c','second',.25]] as const) {
    const path = resolver.resolveNamedLink({ ...link, to: endpoint(id,'DATA_RX_OUT'), via: [{ scopePath: [], connectionId: branch }] });
    assert.equal(path.status, 'resolved');
    const optics = createOpticalBudget(p).calculateDigitalPath(path.trace, channel)!;
    near(number(optics.powerDbm), 10 * Math.log10(share));
    const notes = linkAnnotations(resolver.graph, path, undefined, optics).nodes;
    assert.ok(notes.has(JSON.stringify([id])) && !notes.has(JSON.stringify([id === 'b' ? 'c' : 'b'])));
    assert.deepEqual(projectPathHighlight(path, []).edges, new Set(['launch', branch].map(key => canvasEdgeKey('connection', key))));
  }
});

test('complementary optical branches conserve power, including fractional and dark outputs', () => {
  for (const [percent, loss] of [[50,0], [99,0], [99.9,2], [100,0], [0,0]]) {
    const project = opticalNetwork(percent, loss);
    const graph = buildSignalGraph(project);
    const optics = createOpticalBudget(project);
    const powers = [endpoint('b','OPT_RX_IN'), endpoint('pd','OPT_IN')].map((to, i) => {
      const result = optics.calculateLocal({ source: { endpoint: endpoint('a','OPT_TX_OUT'), channelId: channel }, to });
      const power = number(result.powerDbm);
      near(power, 10 * Math.log10((i ? 100 - percent : percent) / 100) - loss);
      assert.ok(result.stages.every(s => s.channelId === channel));
      near(number(result.stages.at(-2)!.powerDbm), power);
      const notes = linkAnnotations(graph, undefined, undefined, result).nodes.get(JSON.stringify(['split']));
      assert.ok(notes?.some(note => note.role === 'out' && note.value === power));
      if (i) near(number(result.averageCurrent!), 0.8 * 10 ** ((power - 30) / 10));
      return 10 ** (power / 10);
    });
    near(powers[0] + powers[1], 10 ** (-loss / 10));
  }
});

test('zero-share branches stay dark with unknown launch power only on reachable channels', () => {
  for (const firstPercent of [0, 100]) {
    const base = opticalNetwork(firstPercent, 0, true);
    const project: Project = { ...base, componentDefinitions: base.componentDefinitions.map(d => d.id !== 'library-splitter' ? d : {
      ...d, ports: d.ports.map(p => ['OPT_OUT_1', 'OPT_OUT_2'].includes(p.id) ? { ...p, channelIds: ['DWDM_CH30'] } : p),
    }) };
    const optics = createOpticalBudget(project);
    const source = { endpoint: endpoint('a', 'OPT_TX_OUT'), channelId: 'DWDM_CH30' as const };
    const receiver = endpoint('b', 'OPT_RX_IN'), detector = endpoint('pd', 'OPT_IN');
    const darkTarget = firstPercent === 0 ? receiver : detector;
    const dark = optics.calculateLocal({ source, to: darkTarget });
    assert.equal(dark.stages[0].powerDbm.availability, 'unavailable');
    assert.equal(dark.stages[1].powerDbm.availability, 'unavailable');
    assert.equal(number(dark.stages[2].powerDbm), -Infinity);
    assert.equal(number(dark.powerDbm), -Infinity);
    assert.equal(number(dark.gainDb), -Infinity);
    if (firstPercent === 100) assert.equal(number(dark.averageCurrent!), 0);
    else assert.equal(dark.digitalReceiver!.margin.availability, 'unavailable');
    assert.equal(optics.calculateLocal({ source, to: firstPercent === 0 ? detector : receiver }).powerDbm.availability, 'unavailable');
    const blocked = optics.calculateLocal({ source: { ...source, channelId: 'DWDM_CH28' }, to: darkTarget });
    assert.equal(blocked.pathIssue?.status, 'unreachable');
    assert.equal(blocked.powerDbm.availability, 'unavailable');
  }
});

test('full duplex digital links use optical thresholds, never a radio gain', () => {
  const project = parseProjectJson(serializeProjectJson(opticalNetwork(99, 2)));
  const resolver = createPathResolver(project), optics = createOpticalBudget(project);
  for (const [index, link] of project.namedLinks!.slice(0,2).entries()) {
    const path = resolver.resolveNamedLink(link);
    assert.equal(path.status,'resolved');
    const result = optics.calculateDigitalPath(path.trace, channel)!;
    const expected = index ? -2 : 10 * Math.log10(0.99) - 2;
    near(number(result.powerDbm), expected);
    near(number(result.digitalReceiver!.margin), expected + (index ? 15 : 11));
    assert.equal(result.digitalReceiver!.aboveLimit, !!index);
    assert.equal(result.stages.filter(s => s.incoming === undefined).length, 1);
    const radio = createLinkBudget(project).calculatePath(path, { frequencyGHz: 2, inputPowerDbm: 40 });
    assert.equal(radio.powerDbm.availability, 'unavailable');
  }
  const fromOptical = resolver.resolveLocalPath({ from: endpoint('b','OPT_TX_OUT'), to: endpoint('a','DATA_RX_OUT'), channelId: channel });
  assert.equal(fromOptical.status,'resolved');
  near(number(optics.calculateDigitalPath(fromOptical.trace, channel, [
    { endpoint: endpoint('b','OPT_TX_OUT'), channelId:channel, powerDbm:-12 },
  ])!.digitalReceiver!.margin), 3);
  const weak = opticalNetwork(1);
  const weakPath = createPathResolver(weak).resolveNamedLink(weak.namedLinks![0]);
  assert.equal(weakPath.status, 'resolved');
  near(number(createOpticalBudget(weak).calculateDigitalPath(weakPath.trace, channel)!.digitalReceiver!.margin), -9);
  const filtered = { ...weak, componentDefinitions: weak.componentDefinitions.map(d => d.id === 'library-sfp' ? {
    ...d, ports: d.ports.map(p => p.type === 'OPTICAL' ? { ...p, channelIds: [channel] } : p),
  } : d) };
  assert.equal(createPathResolver(filtered).resolveNamedLink({ ...weak.namedLinks![0], channelId: 'DWDM_CH30' }).status, 'unreachable');
  const missing = opticalNetwork(50,0,true), path = createPathResolver(missing).resolveNamedLink(missing.namedLinks![0]);
  assert.equal(path.status, 'resolved');
  const result = createOpticalBudget(missing).calculateDigitalPath(path.trace, channel)!;
  assert.equal(result.powerDbm.availability,'unavailable');
  assert.equal(result.digitalReceiver!.margin.availability,'unavailable');
  const [sfp, splitter] = project.componentDefinitions;
  const config = [sfp, splitter].reduce((lib, d) => saveDefinition(lib, { ...d, id: d.id + '-copy' }), factoryLibrary());
  assert.deepEqual(parseLibrary(JSON.stringify(config)), config);
});

test('an optional DC heater loads its supply without changing MZM signal budgets', () => {
  const ids = ['library-laser','library-mzm','library-pd','library-dc-supply'];
  const definitions = ids.map(id => builtInDefinitions.find(d => d.id === id)! as ComponentDefinition);
  const [laser, mzm, pd, supply] = definitions;
  const configured = definitions.map(d => d.id !== supply.id ? d : { ...d, ports: d.ports.map(p => p.id === 'DC_OUT'
    ? { ...p, outputVoltageV: fixed(5), supplyCapacity: { unit: 'W' as const, value: fixed(10) } } : p) });
  const project: Project = { id: 'heater', name: 'Heater', rootModuleDefinitionId: 'root', componentDefinitions: configured,
    moduleDefinitions: [{ kind: 'module', id: 'root', name: 'System', ports: [],
      instances: definitions.map(d => ({ id: d.id, name: d.name, definitionId: d.id })),
      connections: [wire('supply',laser.id,'OPT_OUT',mzm.id,'LASER_IN'),wire('output',mzm.id,'OPT_OUT',pd.id,'OPT_IN')] }],
    instanceSettings: [
      { instancePath: [laser.id], parameterOverrides: { power: fixed(8) } },
      { instancePath: [mzm.id], parameterOverrides: { vPi: fixed(5), intrinsicLoss: fixed(3) } },
      { instancePath: [pd.id], parameterOverrides: { receiver: 'external50', responsivity: fixed(0.8) } },
    ] };
  const root = project.moduleDefinitions[0];
  const heated: Project = { ...project, componentDefinitions: configured.map(d => d.id === mzm.id ? {
    ...d, ports: [...d.ports,{ id: 'heater', type: 'DC_POWER', direction: 'in' }], dcLoad: { portId: 'heater', powerW: fixed(1.25) },
  } : d), moduleDefinitions: [{ ...root, connections: [...root.connections!,wire('heater',supply.id,'DC_OUT',mzm.id,'heater')] }] };
  const link = { id: 'rf', name: 'RF', from: endpoint(mzm.id,'RF_IN'), to: endpoint(pd.id,'RF_OUT'), channelId: channel };
  const run = (snapshot: Project) => createConversionBudget(snapshot).calculateNamedLink(link, { frequencyGHz: 2, inputPowerDbm: 0 });
  const before = run(project), after = run(parseProjectJson(serializeProjectJson(heated)));
  near(number(before.segments[0].pdPowerDbm), 8 - 3 - 10 * Math.log10(2));
  near(number(before.powerDbm), number(after.powerDbm));
  near(number(calculateDcBudget(heated).loads[0].powerW), 1.25);
});

test('a dark splitter output gives zero detected current and RF output after analog modulation', () => {
  for (const kind of ['dml','mzm']) {
    const base = opticalNetwork(100);
    const tx = builtInDefinitions.find(d => d.id === 'library-' + kind)! as ComponentDefinition;
    const laser = builtInDefinitions.find(d => d.id === 'library-laser')! as ComponentDefinition;
    const root = base.moduleDefinitions[0];
    const project: Project = { ...base, componentDefinitions: [...base.componentDefinitions,tx,laser],
      moduleDefinitions: [{ ...root, instances: [...root.instances, { id:'tx', name:'TX', definitionId:tx.id },
        { id:'laser', name:'Laser', definitionId:laser.id }],
        connections: [wire('launch','tx','OPT_OUT','split','OPT_IN'),wire('detect','split','OPT_OUT_2','pd','OPT_IN'),
          ...(kind === 'mzm' ? [wire('supply','laser','OPT_OUT','tx','LASER_IN')] : [])] }],
      instanceSettings: [...base.instanceSettings!, { instancePath:['laser'], parameterOverrides:{ power:fixed(0) } },
        { instancePath:['tx'], parameterOverrides: kind === 'mzm' ? { vPi:fixed(4), intrinsicLoss:fixed(0) }
          : { power:fixed(0), slope:fixed(0.01) } }] };
    const result = createConversionBudget(project).calculateNamedLink({
      id:'dark', name:'Dark', from:endpoint('tx','RF_IN'), to:endpoint('pd','RF_OUT'), channelId:channel,
    },{ frequencyGHz:4, inputPowerDbm:0 });
    near(number(result.segments[0].averageCurrent), 0);
    near(number(result.powerDbm), -Infinity);
  }
});

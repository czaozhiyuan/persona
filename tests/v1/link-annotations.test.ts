import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { captionNotes, linkAnnotations } from '../../src/editors/topology/v1/link-annotations';
import type { Project, PortDefinition } from '../../src/model/v1/types';
import { canvasEdgeKey, projectPathHighlight } from '../../src/editors/topology/v1/path-highlight';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { createOpticalBudgetForGraph } from '../../src/engine/v1/optical-budget';
import { buildSignalGraph } from '../../src/engine/v1/signal-graph';
import { parseProjectJson } from '../../src/storage/v1/project-json';
import { digitalControlProject } from './fixtures/digital-control-project';

const project = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const graph = buildSignalGraph(project);
const budget = createLinkBudget(project);
const from = { instancePath: ['TX_A', 'laser'], portId: 'OUT' };
const channelId = 'DWDM_CH28';

test('a TTL to TTL link highlights both control legs, the selected MPO core and both mapped boxes using one optical result', () => {
  const fixture = digitalControlProject();
  for (const [index, [tx, rx]] of [['a','b'], ['b','a']].entries()) {
    const graph = buildSignalGraph(fixture), path = createLinkBudget(fixture).resolveNamedLink(fixture.namedLinks![index]);
    assert.equal(path.status, 'resolved');
    const optics = createOpticalBudgetForGraph(graph).calculateDigitalPath(path.trace, 'MM850')!;
    const loss = index ? 1 : 3, annotations = linkAnnotations(graph, path, undefined, optics);
    const root = projectPathHighlight(path, [], { annotations });
    assert.deepEqual(root.edges, new Set([canvasEdgeKey('connection', 'tx-' + tx), canvasEdgeKey('core', 'mpo', tx + rx), canvasEdgeKey('connection', 'rx-' + rx)]));
    assert.deepEqual(root.folded, new Set([tx, rx]));
    assert.deepEqual(projectPathHighlight(path, [tx]).edges, new Set([canvasEdgeKey('mapping', 'DATA_TX_IN'), canvasEdgeKey('mapping', 'OPT_TX_OUT')]));
    assert.deepEqual(projectPathHighlight(path, [rx]).edges, new Set([canvasEdgeKey('mapping', 'OPT_RX_IN'), canvasEdgeKey('mapping', 'DATA_RX_OUT')]));
    assert.match(root.captions.get(canvasEdgeKey('core', 'mpo', tx + rx))!, new RegExp('插损 ' + loss + ' dB'));
    assert.equal(root.captions.get(canvasEdgeKey('connection', 'tx-' + tx)), '控制');
    const notes = (id: string) => captionNotes(annotations.nodes.get(JSON.stringify([id, 'sfp']))!).map(n => n.text);
    assert.ok(notes(tx).includes('光出 0.0 dBm'));
    assert.ok(notes(rx).includes('光入 -' + loss + '.0 dBm'));
    assert.ok(notes(rx).includes('接收余量 ' + (20 - loss) + '.0 dB'));
    assert.ok(!annotations.nodes.has(JSON.stringify(['ctl-' + tx])));
  }
});

test('canvas annotates the selected optical supply, mapped chassis and MPO core using the evaluated trace', () => {
  const link = project.namedLinks!.find(l => l.id === 'full')!;
  const conditions = { frequencyGHz: 2, opticalSources: [{ endpoint: from, channelId, powerDbm: 5 }] } as const;
  const path = budget.resolveNamedLink(link, conditions);
  const point = budget.calculatePath(path, conditions);
  assert.equal(point.kind, 'conversion');
  const annotations = linkAnnotations(graph, path, point);
  const details = (path: string[]) => annotations.nodes.get(JSON.stringify(path))!.map(n => n.detail).join(' / ');
  assert.match(details(from.instancePath), /光出 5.0 dBm/);
  assert.match(details(['TX_A', 'mzm']), /Vπ 5 V/);
  assert.match(details(['TX_A', 'mzm']), /RF 入 0\.0 dBm/);
  assert.match(details(['RX_A', 'pd']), /响应度 0.8 A.W/);
  assert.doesNotMatch(details(['RX_A', 'pd']), /增益/);
  assert.ok(!annotations.nodes.has(JSON.stringify(['RX_B', 'pd'])));
  const notes = (id: string[]) => annotations.nodes.get(JSON.stringify(id))!;
  assert.deepEqual(captionNotes(notes(['RX_A', 'pd'])).map(n => n.kind), ['power', 'power', 'responsivity']);
  assert.deepEqual(captionNotes(notes(['TX_A', 'mzm'])).map(n => n.role), ['in', 'in', 'out']);
  const inputPorts = notes(['TX_A', 'mzm']).filter(n => n.role === 'in').map(n => n.portIndex);
  assert.deepEqual(inputPorts, [...inputPorts].sort((a, b) => a - b));
  assert.equal(captionNotes(notes(['TX_A','laser']))[0].role, 'out');
  const root = projectPathHighlight(path, [], { annotations });
  assert.ok(root.folded.has('TX_A') && root.folded.has('RX_A'));
  const core = root.captions.get(canvasEdgeKey('core', 'mpo-12', 'wdm'));
  assert.match(core!, /dBm.*DWDM_CH28/);
  assert.doesNotMatch(core!, /损耗|增益/);
  assert.ok(annotations.nodes.has(JSON.stringify(['TX_A'])));
  assert.deepEqual(projectPathHighlight(path, []).edges, root.edges);
});

test('RF readings show absolute power at the default drive and remove old values for incomplete links', () => {
  const link = project.namedLinks!.find(l => l.id === 'pure-rf')!;
  const path = budget.resolveNamedLink(link);
  const annotate = (frequencyGHz: number, inputPowerDbm?: number) =>
    linkAnnotations(graph, path, budget.calculatePath(path, { frequencyGHz, inputPowerDbm }));
  const rf5 = JSON.stringify(['TX_A', 'rf5']);
  const labels = annotate(1).nodes.get(rf5)!.map(n => n.text);
  assert.ok(labels.includes('RF 出 15.0 dBm') && labels.includes('增益 5.0 dB'));
  assert.ok(annotate(1, -20).nodes.get(rf5)!.some(n => n.text === 'RF 出 -5.0 dBm'));
  assert.equal(annotate(68).nodes.size, 0);
  const invalid = budget.resolveNamedLink({ ...link, to: undefined });
  assert.equal(linkAnnotations(graph, invalid, budget.calculatePath(invalid, { frequencyGHz: 1 })).nodes.size, 0);
});

test('a standalone optical path only reports optical port readings along its resolved steps', () => {
  const supply = graph.edges.find(edge => edge.from.ref.instancePath.join('/') === 'TX_A/laser')!;
  const link = { id: 'light', name: 'Light', from, to: supply.to.ref, channelId } as const;
  const path = budget.resolveNamedLink(link);
  assert.equal(path.status, 'resolved');
  const optical = createOpticalBudgetForGraph(graph).calculateSourcePath(path.trace, { endpoint: from, channelId, powerDbm: 3 });
  const notes = linkAnnotations(graph, path, undefined, optical);
  const target = notes.nodes.get(JSON.stringify(supply.to.ref.instancePath))!;
  assert.ok(target.some(n => n.text === '光入 3.0 dBm'));
  assert.ok(target.every(n => !/RF|损耗/.test(n.text)));
});

test('a three-pass component and its module show definition-ordered readings and reserve an output in the caption', () => {
  const ids = ['IC','OC','IA','OA','IB','OB','UNUSED'];
  const ports: PortDefinition[] = ids.map(id => ({ id, name: '同名端口', type: 'RF', direction: id.startsWith('O') ? 'out' : 'in' }));
  const fixture: Project = { id: 'p', name: 'p', rootModuleDefinitionId: 'root',
    componentDefinitions: [{ kind: 'component', id: 'device', name: 'Device', ports,
      transfers: ['A','B','C'].map(s => ({ kind: 'rf', fromPortId: 'I'+s, toPortId: 'O'+s, gainDb: { kind: 'fixed', value: 0 } })) }],
    moduleDefinitions: [{ kind: 'module', id: 'module', name: 'Module', ports,
      instances: [{ id: 'inner', name: 'Inner', definitionId: 'device' }],
      portMappings: ports.map(p => ({ portId: p.id, target: { instanceId: 'inner', portId: p.id } })) },
      { kind: 'module', id: 'root', name: 'Root', ports: [], instances: [{ id: 'box', name: 'Box', definitionId: 'module' }],
        connections: [['OA','IB'],['OB','IC']].map(([out,input]) => ({ id: out, from: { instanceId: 'box', portId: out }, to: { instanceId: 'box', portId: input } })) }] };
  const calc = createLinkBudget(fixture);
  const path = calc.resolveNamedLink({ id: 'p', name: 'p', from: { instancePath: ['box'], portId: 'IA' }, to: { instancePath: ['box'], portId: 'OC' } });
  assert.equal(path.status, 'resolved');
  const a = linkAnnotations(buildSignalGraph(fixture), path, calc.calculatePath(path, { frequencyGHz: 2, inputPowerDbm: 0 }));
  for (const key of [['box'],['box','inner']]) {
    const notes = a.nodes.get(JSON.stringify(key))!;
    assert.deepEqual(notes.filter(n => n.kind === 'power').map(n => n.portIndex), [0,2,4,1,3,5]);
    assert.deepEqual(captionNotes(notes).map(n => n.portIndex), [0,2,1]);
    assert.equal(new Set(notes.filter(n => n.kind === 'power').map(n => n.detail)).size, 6);
  }
});

test('a continuous optical source feeding a detector has no numeric RF annotation', () => {
  const root = { ...project.moduleDefinitions.find(d => d.id === project.rootModuleDefinitionId)!,
    ports: [], instances: [{ id: 'source', definitionId: 'demo-laser', name: 'Laser' }, { id: 'detector', definitionId: 'pd', name: 'PD' }],
    connections: [{ id: 'fiber', from: { instanceId: 'source', portId: 'OUT' }, to: { instanceId: 'detector', portId: 'IN' } }],
    cableBundles: [], portMappings: [], parameterMappings: [] };
  const cw = { ...project, moduleDefinitions: [root], namedLinks: [], layout: undefined, instanceSettings: undefined };
  const from = { instancePath: ['source'], portId: 'OUT' };
  const link = { id: 'cw', name: 'CW', from, to: { instancePath: ['detector'], portId: 'RF_OUT' }, channelId } as const;
  const calculator = createLinkBudget(cw);
  const input = { frequencyGHz: 1, inputPowerDbm: 0, opticalSources: [{ endpoint: from, channelId, powerDbm: 2 }] } as const;
  const path = calculator.resolveNamedLink(link, input);
  const point = calculator.calculatePath(path, input);
  assert.equal(point.kind, 'conversion');
  assert.ok(point.continuousWave);
  const notes = linkAnnotations(buildSignalGraph(cw), path, point).nodes.get(JSON.stringify(['detector']))!;
  assert.ok(notes.some(n => n.text === '光入 2.0 dBm'));
  assert.ok(notes.every(n => !n.text.includes('RF')));
  assert.deepEqual(notes.filter(n => n.kind === 'power').map(n => n.role), ['in']);
});

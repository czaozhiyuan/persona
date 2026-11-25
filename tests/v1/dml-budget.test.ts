import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversionBudget, loadedVoltages } from '../../src/engine/v1/conversion-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { captionNotes, linkAnnotations } from '../../src/editors/topology/v1/link-annotations';
import { buildSignalGraph, signalPortKey } from '../../src/engine/v1/signal-graph';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import type { ParameterValue } from '../../src/model/v1/parameters';
import type { ComponentDefinition, EndpointRef, Project } from '../../src/model/v1/types';
import type { NamedLink } from '../../src/model/v1/topology';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const endpoint = (id: string, portId: string): EndpointRef => ({ instancePath: [id], portId });
const wire = (id: string, from: string, out: string, to: string, input: string) =>
  ({ id, from: { instanceId: from, portId: out }, to: { instanceId: to, portId: input } });
const link: NamedLink = { id: 'link', name: 'RF', from: endpoint('tx', 'RF_IN'), to: endpoint('pd', 'RF_OUT'), channelId: 'DWDM_CH28' };
const excitation = { frequencyGHz: 2, inputPowerDbm: 0 };
const halfPower = -10 * Math.log10(2);

function fixture(overrides: Record<string, ParameterValue> = {}, gain = halfPower, receiver = 'external50'): Project {
  const ids = ['library-dml', 'library-optical-switch', 'library-pd', 'library-rf-gain'];
  const defs = ids.map(id => builtInDefinitions.find(d => d.id === id)! as ComponentDefinition);
  const [dml, optical, pd, amp] = defs;
  // Use an unrelated definition ID and a public input to exercise semantic dispatch and port mappings.
  const custom = { ...dml, id: 'custom-source', name: 'Custom source',
    parameters: dml.parameters?.map(p => ({ ...p, defaultValue: undefined })) };
  return { id: 'dml-test', name: 'DML', rootModuleDefinitionId: 'root', componentDefinitions: [custom, optical, pd, amp],
    moduleDefinitions: [{ kind: 'module', id: 'tx-module', name: 'TX', ports: custom.ports.map(({ opticalEmitter, ...p }) => p),
      instances: [{ id: 'source', name: 'Source', definitionId: custom.id }],
      portMappings: custom.ports.map(p => ({ portId: p.id, target: { instanceId: 'source', portId: p.id } })) },
      { kind: 'module', id: 'root', name: 'System', ports: [],
        instances: [['pre', amp.id], ['tx', 'tx-module'], ['sw', optical.id], ['pd', pd.id], ['post', amp.id]]
          .map(([id, definitionId]) => ({ id, name: id, definitionId, switchStateId: id === 'sw' ? 'pass' : undefined })),
        connections: [wire('a','pre','RF_OUT','tx','RF_IN'), wire('b','tx','OPT_OUT','sw','OPT_IN'),
          wire('c','sw','OPT_OUT','pd','OPT_IN'), wire('d','pd','RF_OUT','post','RF_IN')] }],
    instanceSettings: [{ instancePath: ['tx','source'], parameterOverrides: overrides },
      { instancePath: ['sw'], switchStateId: 'pass', parameterOverrides: { gain: fixed(gain) } },
      { instancePath: ['pd'], parameterOverrides: { receiver, responsivity: fixed(0.8) } }], namedLinks: [link] };
}

function near(metric: BudgetMetric, expected: number, tol = 1e-9) {
  assert.equal(metric.availability, 'available');
  assert.ok(Math.abs(metric.value - expected) <= tol, `${metric.value} != ${expected}`);
}

const values = { power: fixed(10), slope: fixed(0.005) };
const calculate = (p: Project, l = link, conditions: { frequencyGHz: number; inputPowerDbm?: number } = excitation) =>
  createConversionBudget(p).calculateNamedLink(l, conditions);

test('loaded DML link separates average light and modulation through a hierarchical switched path', () => {
  const project = parseProjectJson(serializeProjectJson(fixture(values)));
  const point = calculate(project);
  const segment = point.segments[0], tx = segment.transmitter;
  assert.equal(tx.kind, 'dml');
  near(tx.inputPeak, 0.316227766);
  near(tx.opticalPeak, 0.001581138830);
  near(segment.modulationDepth, 0.158113883);
  near(segment.pdPowerDbm, 6.989700043);
  near(tx.receivedPeak, 0.000790569415);
  near(tx.loadedResponse, 40);
  near(segment.averageCurrent, 0.004);
  near(point.powerDbm, -20);
  near(point.gainDb, -20);
  near(loadedVoltages(point.powerDbm).vpk, 0.0316227766);
  near(loadedVoltages(point.powerDbm).vrms, 0.0223606798);
  near(loadedVoltages(point.powerDbm).vpp, 0.0632455532);
  assert.equal(point.nfDb.availability, 'unavailable');
  near(calculate(fixture(values, halfPower - 3)).powerDbm, -26);
  near(calculate(fixture({ ...values, slope: fixed(0.01) })).powerDbm, -20 + 20 * Math.log10(2));
  near(calculate(fixture(values, halfPower, 'parallel50')).powerDbm, -20 - 20 * Math.log10(2));
  const higher = calculate(fixture({ ...values, power: fixed(10 - halfPower) })).segments[0];
  near(higher.pdPowerDbm, 10);
  near(higher.averageCurrent, 0.008);
  near(higher.modulationDepth, 0.158113883 / 2);
  near(higher.gainDb, -20);
  near(calculate(project, link, { ...excitation, inputPowerDbm: 1 }).powerDbm, -19);
  assert.equal(calculate(project, link, { ...excitation, inputPowerDbm: 6 }).segments[0].extrapolated, true);
  const both = calculate(project, { ...link, from: endpoint('pre','RF_IN'), to: endpoint('post','RF_OUT') });
  near(both.powerDbm, -8);
  near(both.segments[0].rfOutputDbm, -14);
  const txModule = project.moduleDefinitions[0];
  const mapped: Project = { ...project, moduleDefinitions: [{ ...txModule, parameters: [{ kind: 'numeric', id: 'moduleSlope',
    name: 'Mapped slope', unit: 'W/V', valueKind: 'rfValue', range: { min: 0 }, defaultValue: fixed(0.01) }],
    parameterMappings: [{ parameterId: 'moduleSlope', target: { instanceId: 'source', parameterId: 'slope' } }] }, project.moduleDefinitions[1]],
    instanceSettings: project.instanceSettings!.map(s => s.instancePath.length === 2 ? { ...s, parameterOverrides: { power: values.power } } : s) };
  near(calculate(parseProjectJson(serializeProjectJson(mapped))).gainDb, -20 + 20 * Math.log10(2));
});

test('DML missing inputs, K interpolation, CW, blocked switch and zero drive preserve independent metrics', () => {
  const project = fixture(values);
  const absent = calculate(project, link, { frequencyGHz: 2 });
  near(absent.gainDb, -20);
  for (const metric of [absent.powerDbm, absent.segments[0].modulationDepth]) assert.equal(metric.availability, 'unavailable');
  const noMean = calculate(fixture({ slope: values.slope }));
  near(noMean.powerDbm, -20);
  assert.deepEqual(noMean.segments[0].pdPowerDbm.availability, 'unavailable');
  assert.match(JSON.stringify(noMean.segments[0].modulationDepth), /P0/);
  const noSlope = calculate(fixture({ power: values.power }));
  near(noSlope.segments[0].pdPowerDbm, 10 + halfPower);
  assert.match(JSON.stringify(noSlope.gainDb), /直调系数/);
  const curve = fixture({ power: { kind: 'channelTable', values: { DWDM_CH28: 10 } },
    slope: { kind: 'rfCurve', points: [[1,0.002],[3,0.008]] } });
  const scan = createLinkBudget(curve).scanNamedLink(link, { startGHz: 0, stopGHz: 4 }, { inputPowerDbm: 0 });
  assert.equal(scan.status, 'complete');
  near(scan.points[2].powerDbm, -20);
  for (const index of [0,4]) assert.match(JSON.stringify(scan.points[index].gainDb), /超出曲线范围/);
  const source = { endpoint: { instancePath: ['tx','source'], portId: 'OPT_OUT' }, channelId: 'DWDM_CH28' as const };
  const local = createOpticalBudget(curve).calculateLocal({ source, to: endpoint('pd','OPT_IN') });
  near(local.powerDbm, 10 + halfPower);
  const cw = calculate(project, { ...link, from: source.endpoint });
  near(cw.continuousWave!.averageCurrent, 0.004);
  assert.equal(cw.powerDbm.availability, 'unavailable');
  const blocked = calculate({ ...project, instanceSettings: project.instanceSettings!.map(s => s.switchStateId ? { ...s, switchStateId: 'block' } : s) });
  near(blocked.partialDml!.emission.mean, 10);
  assert.match(JSON.stringify(blocked.powerDbm), /光开关.*阻断/);
  assert.equal(blocked.gainDb.availability, 'unavailable');
  const mismatch = calculate({ ...project, componentDefinitions: project.componentDefinitions.map(d => d.id === 'library-pd'
    ? { ...d, ports: d.ports.map(p => p.type === 'OPTICAL' ? { ...p, channelIds: ['CWDM_1511'] } : p) } : d) });
  near(mismatch.partialDml!.optical!.powerDbm, 10 + halfPower);
  assert.match(JSON.stringify(mismatch.powerDbm), /DWDM_CH28/);
  const zero = calculate(fixture({ ...values, slope: fixed(0) }), link, { ...excitation, inputPowerDbm: -Infinity });
  assert.deepEqual(zero.powerDbm, { unit: 'dBm', availability: 'available', value: -Infinity });
  near(loadedVoltages(zero.powerDbm).vrms, 0);
  assert.throws(() => serializeProjectJson(fixture({ ...values, slope: fixed(-1) })));
});

function partialResult(project: Project, trial: NamedLink) {
  const snapshot = parseProjectJson(serializeProjectJson({ ...project, namedLinks: [trial] }));
  const budget = createLinkBudget(snapshot);
  const path = budget.resolveNamedLink(trial);
  const point = budget.calculatePath(path, excitation);
  assert.equal(path.status, 'unreachable');
  assert.equal(point.gainDb.availability, 'unavailable');
  assert.equal(point.powerDbm.availability, 'unavailable');
  const annotations = linkAnnotations(buildSignalGraph(snapshot), path, point);
  return { point, reason: path.reason, annotations };
}

test('DML shows RF input, average optical output and K; another channel or different unrounded power stays distinct', () => {
  const project = fixture(values), graph = buildSignalGraph(project), budget = createLinkBudget(project);
  const path = budget.resolveNamedLink(link);
  const point = budget.calculatePath(path, excitation);
  assert.equal(point.kind, 'conversion');
  const { optical } = point.segments[0];
  assert.ok(optical);
  const stage = optical.stages[0];
  const first = linkAnnotations(graph, path, point).nodes.get('["tx","source"]')!;
  assert.deepEqual(captionNotes(first).map(n => n.text), ['RF 入 0.0 dBm', '光出 P0 10.0 dBm', 'K 0.005 W/V']);
  assert.equal(first.filter(n => n.role === 'out').length, 1);
  const other = { ...optical, stages: [{ ...stage, channelId: 'DWDM_CH30' as const },
    { ...stage, powerDbm: { unit: 'dBm' as const, availability: 'available' as const, value: 10.02 } }] };
  const outputs = linkAnnotations(graph, path, point, other).nodes.get('["tx","source"]')!.filter(n => n.role === 'out');
  assert.deepEqual(outputs.map(n => [n.channel, n.value]).sort(), [['DWDM_CH28',10],['DWDM_CH28',10.02],['DWDM_CH30',10]]);
});

test('a rejected DML output channel preserves the RF stages and their diagram annotations', () => {
  const project = fixture(values);
  const restricted: Project = { ...project, componentDefinitions: project.componentDefinitions.map(d => d.id === 'custom-source'
    ? { ...d, ports: d.ports.map(p => p.id === 'OPT_OUT' ? { ...p, channelIds: ['DWDM_CH28'] } : p) } : d) };
  const trial: NamedLink = { ...link, from: endpoint('pre','RF_IN'), channelId: 'DWDM_CH30' };
  const { point, reason, annotations } = partialResult(restricted, trial);
  assert.match(reason, /不支持光通道.*DWDM_CH30/);
  assert.equal(point.kind, 'rf');
  const dmlInput = { instancePath: ['tx','source'], portId: 'RF_IN' };
  assert.deepEqual(point.stages.at(-1)!.endpoint, dmlInput);
  near(point.stages[0].powerDbm, 0);
  near(point.stages.at(-1)!.powerDbm, 6);
  assert.equal(annotations.ports.get(signalPortKey(dmlInput)), 'RF 6.0 dBm');
  assert.equal(annotations.ports.get(signalPortKey(endpoint('pre','RF_IN'))), 'RF 0.0 dBm');
  assert.match(annotations.nodes.get('["pre"]')!.map(n => n.text).join(' / '), /增益 6\.0 dB/);
  assert.ok(!annotations.ports.has(signalPortKey(endpoint('pd','RF_OUT'))));
});

test('a break after the PD preserves its RF output but leaves the requested endpoint unavailable', () => {
  const project = fixture(values), root = project.moduleDefinitions[1];
  const broken = { ...project, moduleDefinitions: [project.moduleDefinitions[0],
    { ...root, connections: root.connections!.filter(c => c.id !== 'd') }] };
  const trial = { ...link, from: endpoint('pre','RF_IN'), to: endpoint('post','RF_OUT') };
  const { point, reason, annotations } = partialResult(broken, trial);
  assert.equal(point.kind, 'conversion');
  assert.equal(point.segments.length, 1);
  near(point.segments[0].pdPowerDbm, 10 + halfPower);
  near(point.segments[0].rfOutputDbm, -14);
  assert.match(reason, /射频.*未接通/);
  assert.equal(annotations.ports.get(signalPortKey(endpoint('pd','RF_OUT'))), 'RF -14.0 dBm');
  assert.ok(!annotations.ports.has(signalPortKey(trial.to)));
});

test('an externally modulated DML supply does not silently yield a single-modulator budget', () => {
  const project = fixture(values), root = project.moduleDefinitions[1];
  const mzm = builtInDefinitions.find(d => d.id === 'library-mzm')!;
  const chain: Project = { ...project, componentDefinitions: [...project.componentDefinitions, mzm], moduleDefinitions: [
    project.moduleDefinitions[0], { ...root, instances: [...root.instances, { id: 'mzm', name: 'External modulator', definitionId: mzm.id }],
      connections: [...root.connections!.filter(c => c.id !== 'c'), wire('supply','sw','OPT_OUT','mzm','LASER_IN'), wire('light','mzm','OPT_OUT','pd','OPT_IN')] }] };
  for (const from of [link.from, endpoint('mzm','RF_IN')]) {
    const point = calculate(chain, { ...link, from });
    assert.match(JSON.stringify(point.gainDb), /不支持.*串联调制/);
  }
  const local = createOpticalBudget(chain).calculateLocal({ eo: { instancePath: ['mzm'], fromPortId: 'RF_IN', toPortId: 'OPT_OUT' },
    channelId: 'DWDM_CH28', sources: [], to: endpoint('pd','OPT_IN') });
  assert.match(JSON.stringify(local.powerDbm), /不支持.*串联调制/);
});

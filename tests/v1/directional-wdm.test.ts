import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createMultiplexPower } from '../../src/engine/v1/multiplex-power';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { buildSignalGraph } from '../../src/engine/v1/signal-graph';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import type { ComponentDefinition } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { endpoint, fixed, local, wdmProject } from './fixtures/wdm-project';

const numeric = (metric: BudgetMetric) => { assert.equal(metric.availability, 'available'); return metric.value; };
function near(actual: BudgetMetric, expected: number) {
  assert.ok(Math.abs(numeric(actual) - expected) < 1e-9, `${numeric(actual)} != ${expected}`);
}
function trunk(modulated: boolean, percent: number) {
  const p = wdmProject(modulated), root = p.moduleDefinitions[0];
  for (const id of ['library-optical-attenuator', 'library-splitter']) {
    const d = builtInDefinitions.find(d => d.id === id)! as ComponentDefinition;
    p.componentDefinitions = [...p.componentDefinitions, d];
  }
  root.instances = [...root.instances, { id: 'atten', name: '公共衰减', definitionId: 'library-optical-attenuator' },
    { id: 'split', name: '公共分路', definitionId: 'library-splitter', parameterOverrides: { firstPercent: fixed(percent) } }];
  root.connections = [
    { ...root.connections![0], to: local('atten','OPT_IN') },
    { id: 'next', from: local('atten','OPT_OUT'), to: local('split','OPT_IN') },
    { id: 'branch', from: local('split','OPT_OUT_1'), to: local('B','COM') },
  ];
  return parseProjectJson(serializeProjectJson(p));
}

test('WDM launch, receive, trunk and tap show the powers at their own locations in both directions', () => {
  for (const percent of [50, 99]) {
    const mux = createMultiplexPower(buildSignalGraph(trunk(false, percent)));
    const shareDb = 10 * Math.log10(percent / 100), two = 10 * Math.log10(2);
    const a = mux.at(endpoint('A','wdm','COM'))!, b = mux.at(endpoint('B','wdm','COM'))!;
    for (const point of [a, b]) {
      near(point.out.known, -1 + two);
      near(point.in.known, -1 - 2 - 3 + shareDb + two);
      assert.equal(point.waves.length, 4);
      for (const wave of point.waves) near(wave.power, wave.flow === 'out' ? -1 : -6 + shareDb);
    }
    const tap = mux.at({ instancePath: ['split'], portId: 'OPT_OUT_2' })!;
    assert.equal(tap.waves.length, 2);
    assert.ok(tap.waves.every(w => w.flow === 'out' && ['CWDM_1311','CWDM_1351'].includes(w.channelId)));
    near(tap.out.known, -6 + 10 * Math.log10(1 - percent / 100) + two);
    assert.equal(tap.in.known.availability, 'unavailable');
  }
});

test('public bidirectional attenuation and splitting change MZM and DML PD power and RF gain per carrier', () => {
  const base = wdmProject(true), project = trunk(true, 50);
  const unmodified = createLinkBudget(base), inserted = createLinkBudget(project);
  const delta = -3 + 10 * Math.log10(.5);
  for (const [i, kind] of [[0, 'mzm'], [2, 'dml']] as const) {
    const link = project.namedLinks![i], excitation = { frequencyGHz: 15, inputPowerDbm: -20 };
    const before = unmodified.calculateNamedLink(link, excitation), after = inserted.calculateNamedLink(link, excitation);
    assert.equal(before.kind, 'conversion');
    assert.equal(after.kind, 'conversion');
    assert.equal(after.segments[0].transmitter.kind, kind);
    assert.equal(after.segments[0].channelId, link.channelId);
    near(after.segments[0].pdPowerDbm, numeric(before.segments[0].pdPowerDbm) + delta);
    near(after.powerDbm, numeric(before.powerDbm) + 2 * delta);
    const travelled = after.segments[0].optical!.stages.filter(s =>
      s.incoming?.edge.source.kind === 'transfer' && ['atten','split'].includes(s.endpoint.instancePath[0]));
    assert.deepEqual(travelled.map(s => s.endpoint.instancePath[0]), i === 0 ? ['atten','split'] : ['split','atten']);
    assert.ok(travelled.every(s => s.channelId === link.channelId));
  }
});

function combiner(firstPercent: number, mainBranch: number, connectSpare: boolean) {
  const p = wdmProject(true), root = p.moduleDefinitions[0];
  const splitter = builtInDefinitions.find(d => d.id === 'library-splitter')! as ComponentDefinition;
  const laser = p.componentDefinitions.find(d => d.id === 'library-laser')!;
  p.componentDefinitions = [...p.componentDefinitions, splitter, { ...laser, id: 'spare1311',
    ports: laser.ports.map(port => port.opticalEmitter
      ? { ...port, channelIds: ['CWDM_1311'], opticalEmitter: { powerDbm: fixed(0) } } : port) }];
  root.instances = [...root.instances, { id: 'split', name: 'Combiner', definitionId: splitter.id,
    parameterOverrides: { firstPercent: fixed(firstPercent) } }, { id: 'spare', name: 'Spare', definitionId: 'spare1311' }];
  root.connections = [{ id: 'main', from: local('A','COM'), to: local('split','OPT_OUT_' + mainBranch) },
    { ...root.connections![0], from: local('split','OPT_IN') }];
  if (connectSpare) root.connections = [...root.connections, {
    id: 'spare', from: local('spare','OPT_OUT'), to: local('split','OPT_OUT_' + (3 - mainBranch)),
  }];
  return p;
}

test('a cochannel source on a dark combiner branch does not block WDM, PD or RF in either direction', () => {
  const trial = { frequencyGHz: 15, inputPowerDbm: -20 };
  for (const [ratio, branch] of [[100,1], [0,2], [50,1], [50,2]]) {
    for (const spare of [true, false]) {
      const p = combiner(ratio, branch, spare);
      const mux = createMultiplexPower(buildSignalGraph(p)), budget = createLinkBudget(p);
      const splitDb = ratio === 50 ? -10 * Math.log10(2) : 0;
      for (const [i, rx, comDbm, pdDbm, rfDbm] of [
        [0, 'B', -3 - 10 * Math.log10(2), -4 - 10 * Math.log10(2), -66.01580271955808],
        [2, 'A', -3, -4, -29.938200260161125],
      ] as const) {
        const link = p.namedLinks![i], point = mux.at(endpoint(rx,'wdm','COM'))!;
        const recv = point.waves.find(w => w.flow === 'in' && w.channelId === link.channelId)!;
        const rf = budget.calculateNamedLink(link, trial);
        assert.equal(rf.kind, 'conversion');
        if (i === 0 && ratio === 50 && spare) {
          assert.equal(recv.sources.length, 2);
          assert.equal(point.in.partial, true);
          for (const metric of [recv.power, rf.segments[0].pdPowerDbm, rf.powerDbm]) {
            assert.equal(metric.availability, 'unavailable');
            assert.match(metric.reason, /同方向、同波长/);
          }
        } else {
          assert.equal(recv.sources.length, 1);
          assert.equal(point.in.partial, false);
          near(recv.power, comDbm + splitDb);
          near(rf.segments[0].pdPowerDbm, pdDbm + splitDb);
          near(rf.powerDbm, rfDbm + 2 * splitDb);
        }
      }
    }
  }
});

test('a dark splitter branch has zero power even with unknown launch power; a transmitting branch stays unknown', () => {
  for (const ratio of [100, 50]) {
    const p = combiner(ratio, 1, true), root = p.moduleDefinitions[0];
    root.connections = root.connections!.filter(c => c.id !== 'main');
    const spare = p.componentDefinitions.find(d => d.id === 'spare1311')!;
    spare.ports = spare.ports.map(port => port.opticalEmitter ? { ...port, opticalEmitter: {} } : port);
    const result = createOpticalBudget(p).calculateLocal({ source: { endpoint: { instancePath: ['spare'], portId: 'OPT_OUT' },
      channelId: 'CWDM_1311' }, to: endpoint('B','wave0','OPT_IN') });
    const wave = createMultiplexPower(buildSignalGraph(p)).readWave(endpoint('B','wdm','COM'), 'CWDM_1311', 'in');
    if (ratio === 100) {
      assert.equal(numeric(result.powerDbm), -Infinity);
      assert.deepEqual(wave?.sources, []);
      assert.equal(numeric(wave!.power), -Infinity);
    } else {
      assert.equal(wave?.sources.length, 1);
      assert.equal(wave?.power.availability, 'unavailable');
      assert.equal(result.powerDbm.availability, 'unavailable');
    }
  }
});

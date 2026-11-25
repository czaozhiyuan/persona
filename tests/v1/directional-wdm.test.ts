import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createMultiplexPower } from '../../src/engine/v1/multiplex-power';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { buildSignalGraph } from '../../src/engine/v1/signal-graph';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import type { ComponentDefinition } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { endpoint, fixed, local, wdmProject } from './fixtures/wdm-project';

const numeric = (metric: BudgetMetric) => { assert.equal(metric.availability, 'available'); return metric.value; };
function near(actual: BudgetMetric, expected: number) {
  const value = numeric(actual);
  assert.ok(value === expected || Math.abs(value - expected) < 1e-9, `${value} != ${expected}`);
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

test('split and rejoined power follows the number of transmitting legs and explicit route constraints', () => {
  const ratios = [0, 50, 100];
  const pairs = ratios.flatMap(ratio => ratios.map(mergeRatio => [ratio, mergeRatio]));
  for (const [ratio, mergeRatio] of pairs) for (const legs of [[], [1], [2], [1,2]]) {
    const share = (leg: number) => leg === 1 ? ratio * mergeRatio / 10000 : (100 - ratio) * (100 - mergeRatio) / 10000;
    const active = legs.filter(leg => share(leg) > 0);
    const p = combiner(mergeRatio, 1, false), root = p.moduleDefinitions[0];
    root.instances = [...root.instances, { id: 'divider', name: 'Divider', definitionId: 'library-splitter',
      parameterOverrides: { firstPercent: fixed(ratio) } }];
    root.connections = [root.connections![1], { id: 'launch', from: local('A','COM'), to: local('divider','OPT_IN') },
      ...legs.map(i => ({ id: 'leg' + i, from: local('divider','OPT_OUT_' + i), to: local('split','OPT_OUT_' + i) }))];
    const resolver = createPathResolver(p), optical = createOpticalBudget(p), budget = createLinkBudget(p);
    const mux = createMultiplexPower(resolver.graph), trial = { frequencyGHz: 15, inputPowerDbm: -20 };
    for (const [index, receiver] of [[0, 'B'], [2, 'A']] as const) {
      const link = p.namedLinks![index], channelId = link.channelId!, to = endpoint(receiver,'wave' + index,'OPT_IN');
      const localPower = index === 0 ? optical.calculateLocal({ eo: { instancePath: ['A','mzm'], fromPortId: 'RF_IN', toPortId: 'OPT_OUT' },
        sources: [], channelId, to }) : optical.calculateLocal({ source: { endpoint: endpoint('B','wave2','OPT_OUT'), channelId }, to });
      const named = resolver.resolveNamedLink(link), rf = budget.calculateNamedLink(link, trial);
      const wave = mux.readWave(endpoint(receiver,'wdm','COM'), channelId, 'in');
      if (!legs.length) {
        assert.equal(named.status, 'unreachable');
        assert.equal(localPower.pathIssue?.status, 'unreachable');
        assert.equal(wave, undefined);
        assert.equal(rf.powerDbm.availability, 'unavailable');
        continue;
      }
      assert.ok(wave);
      if (active.length > 1) {
        assert.equal(named.status, 'ambiguous');
        assert.equal(localPower.pathIssue?.status, 'ambiguous');
        assert.equal(wave.power.availability, 'unavailable');
        assert.equal(rf.powerDbm.availability, 'unavailable');
        continue;
      }
      assert.equal(named.status, 'resolved');
      assert.equal(rf.kind, 'conversion');
      const tracedLegs = named.trace.edges.flatMap(e => e.source.kind === 'connection' && e.source.ref.connectionId.startsWith('leg')
        ? [e.source.ref.connectionId] : []);
      assert.deepEqual(tracedLegs, (legs.length === 1 ? legs : active).map(leg => 'leg' + leg));
      const basePd = -4 - (index === 0 ? 10 * Math.log10(2) : 0);
      const baseRf = index === 0 ? -66.01580271955808 : -29.938200260161125;
      const gain = 10 * Math.log10(active.length ? share(active[0]) : 0);
      const pdDbm = basePd + gain;
      near(wave.power, pdDbm + 1);
      near(localPower.powerDbm, pdDbm);
      near(rf.segments[0].pdPowerDbm, pdDbm);
      near(rf.powerDbm, baseRf + 2 * gain);
      for (const leg of legs) {
        const explicit = { ...link, via: [{ scopePath: [], connectionId: 'leg' + leg }] };
        assert.equal(resolver.resolveNamedLink(explicit).status, 'resolved');
        const via = budget.calculateNamedLink(explicit, trial), legGain = 10 * Math.log10(share(leg));
        assert.equal(via.kind, 'conversion');
        near(via.segments[0].pdPowerDbm, basePd + legGain);
        near(via.powerDbm, baseRf + 2 * legGain);
      }
    }
  }
});

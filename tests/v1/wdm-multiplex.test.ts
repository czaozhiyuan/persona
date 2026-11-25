import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { createMultiplexPower } from '../../src/engine/v1/multiplex-power';
import { createOpticalBudget, createOpticalBudgetForGraph } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { endpoint, fixed, local, wdmProject } from './fixtures/wdm-project';

function numeric(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}
function near(metric: BudgetMetric, value: number) { assert.ok(Math.abs(numeric(metric) - value) < 1e-9); }

test('two nested WDMs multiplex four separate waves over one lossy fibre or MPO core', () => {
  for (const mpo of [false, true]) {
    const p = wdmProject();
    if (mpo) {
      const root = p.moduleDefinitions[0];
      root.connections = [];
      root.cableBundles = [{ id: 'MPO', coreCount: 12, cores: [{ id: 'core1', lossDb: 2,
        a: { pin: 1, endpoint: local('A', 'COM') }, b: { pin: 12, endpoint: local('B', 'COM') } }] }];
    }
    const restored = parseProjectJson(serializeProjectJson(p));
    const resolver = createPathResolver(restored), optical = createOpticalBudgetForGraph(resolver.graph);
    const multiplex = createMultiplexPower(resolver.graph);
    for (const box of ['A', 'B']) {
      for (const ref of [endpoint(box, 'wdm', 'COM'), {instancePath: [box], portId: 'COM'}]) {
        const point = multiplex.at(ref)!;
        near(point.out.known, 2.010299956639812);
        near(point.in.known, .010299956639812);
        assert.equal(point.waves.length, 4);
        assert.ok(point.waves.every(w => numeric(w.power) === (w.flow === 'out' ? -1 : -3)));
      }
    }
    for (const link of restored.namedLinks!) {
      const path = resolver.resolveNamedLink(link);
      assert.equal(path.status, 'resolved');
      const point = optical.calculateSourcePath(path.trace);
      near(point.powerDbm, -4);
      assert.deepEqual(point.stages.filter(s => s.endpoint.portId === 'COM').map(s => numeric(s.powerDbm)), [-1, -1, -3, -3]);
    }
    assert.equal(multiplex.at(endpoint('A', 'wdm', 'CH1')), undefined);
  }
});

test('source changes, unused channels, missing power and cochannel conflicts are local to their wave and direction', () => {
  const p = wdmProject(), a = p.moduleDefinitions[1];
  const emitter = a.instances.find(i => i.id === 'wave0')!;
  const get = () => createMultiplexPower(createPathResolver(p).graph);
  emitter.parameterOverrides = { power: fixed(3) };
  const changed = get();
  const aPower = changed.at(endpoint('A', 'wdm', 'COM'))!, bPower = changed.at(endpoint('B', 'wdm', 'COM'))!;
  near(aPower.out.known, 10 * Math.log10(10 ** .2 + 10 ** -.1));
  near(aPower.in.known, .010299956639812);
  near(bPower.in.known, numeric(aPower.out.known) - 2);
  near(bPower.out.known, 2.010299956639812);
  const trial = createMultiplexPower(createPathResolver(p).graph, [{endpoint: endpoint('A', 'wave0', 'OPT_OUT'), channelId: 'CWDM_1311', powerDbm: 5}]);
  near(trial.at(aPower.ref)!.waves[0].power, 4);
  near(trial.at(aPower.ref)!.in.known, .010299956639812);
  p.namedLinks = [...p.namedLinks!, { ...p.namedLinks![0], id: 'same-physical-wave' }];
  assert.deepEqual(get().at(aPower.ref), aPower);
  emitter.parameterOverrides = {};
  const laser = p.componentDefinitions.find(d => d.id === 'library-laser')!;
  laser.parameters = laser.parameters?.map(param => ({ ...param, defaultValue: undefined }));
  const missing = get().at(aPower.ref)!;
  assert.ok(missing.out.partial);
  near(missing.out.known, -1);
  assert.equal(missing.waves[0].power.availability, 'unavailable');
  const branch = a.connections!.find(c => c.id === 'branch0')!;
  a.connections = a.connections!.filter(c => c !== branch);
  const open = get().at(aPower.ref)!;
  near(open.out.known, -1);
  assert.equal(open.out.partial, false);
  assert.equal(open.waves.length, 3);
  a.instances = [...a.instances, { ...emitter, id: 'spare', name: 'Spare', parameterOverrides: { power: fixed(2) } }];
  a.connections = [...a.connections, branch, { ...branch, id: 'second', from: local('spare', 'OPT_OUT') }];
  const conflict = get().at(aPower.ref)!;
  assert.equal(conflict.waves[0].sources.length, 2);
  assert.equal(conflict.waves[0].power.availability, 'unavailable');
  assert.match(conflict.waves[0].power.reason, /多路来源/);
  near(conflict.out.known, -1);
  const link = p.namedLinks![0];
  const trace = createPathResolver(p).resolveNamedLink(link);
  assert.equal(trace.status, 'resolved');
  const optical = createOpticalBudget(p);
  assert.equal(optical.calculateSourcePath(trace.trace).pathIssue?.status, 'ambiguous');
  assert.equal(optical.calculateLocal({ source: {endpoint: link.from!, channelId: link.channelId}, to: link.to! }).powerDbm.availability, 'unavailable');
});

test('MZM and DML RF remain attached to their original carriers through both WDMs and the shared fibre', () => {
  const p = parseProjectJson(serializeProjectJson(wdmProject(true)));
  const mux = createMultiplexPower(createPathResolver(p).graph);
  const tx = mux.at(endpoint('A', 'wdm', 'COM'))!.waves.find(w => w.channelId === 'CWDM_1311')!;
  assert.deepEqual(tx.sources, [endpoint('A', 'wave0', 'OPT_OUT')]);
  near(tx.power, -1 - 10 * Math.log10(2));
  const withLoss = createLinkBudget(p);
  const ideal = structuredClone(p);
  ideal.moduleDefinitions[0].connections![0].lossDb = 0;
  for (const box of ideal.moduleDefinitions.slice(1)) box.instances[0].parameterOverrides = { insertionLoss: fixed(0) };
  const withoutLoss = createLinkBudget(ideal);
  for (const [i, kind] of [[0, 'mzm'], [2, 'dml']] as const) {
    const link = p.namedLinks![i], trial = {frequencyGHz: 15, inputPowerDbm: -20};
    const actual = withLoss.calculateNamedLink(link, trial), baseline = withoutLoss.calculateNamedLink(link, trial);
    assert.equal(actual.kind, 'conversion');
    assert.equal(baseline.kind, 'conversion');
    assert.equal(actual.segments[0].transmitter.kind, kind);
    assert.equal(actual.segments[0].channelId, link.channelId);
    near(actual.segments[0].pdPowerDbm, -4 - (kind === 'mzm' ? 10 * Math.log10(2) : 0));
    near(actual.gainDb, numeric(baseline.gainDb) - 8);
    near(actual.powerDbm, numeric(actual.gainDb) - 20);
    assert.ok(actual.segments[0].optical!.stages.every(s => s.channelId === link.channelId));
  }
  const eo = p.componentDefinitions.find(d => d.id === 'library-mzm')!;
  eo.transfers = eo.transfers!.map(t => ({ ...t, channelIds: ['CWDM_1351'] }));
  const rejected = createMultiplexPower(createPathResolver(p).graph).at(endpoint('A', 'wdm', 'COM'))!;
  assert.ok(rejected.waves.every(w => w.channelId !== 'CWDM_1311'));
});

test('each common segment reports power at its own end after attenuation and splitting', () => {
  const p = wdmProject(), root = p.moduleDefinitions[0];
  p.componentDefinitions = [...p.componentDefinitions, { id: 'splitter', kind: 'component', name: 'Splitter',
    ports: [{ id: 'IN', type: 'OPTICAL', direction: 'in' }, { id: 'B', type: 'OPTICAL', direction: 'out' },
      { id: 'TAP', type: 'OPTICAL', direction: 'out' }],
    transfers: [{ kind: 'splitter', fromPortId: 'IN', toPortId: 'B', secondPortId: 'TAP', firstPercent: fixed(75) }] }];
  root.instances = [...root.instances, { id: 'splitter', name: 'Splitter', definitionId: 'splitter' }];
  root.connections = [{ id: 'feed', from: local('A', 'COM'), to: local('splitter', 'IN'), lossDb: 2 },
    { id: 'to-B', from: local('splitter', 'B'), to: local('B', 'COM'), lossDb: 1 }];
  const mux = createMultiplexPower(createPathResolver(p).graph);
  const split = (portId: string) => mux.at({ instancePath: ['splitter'], portId })!;
  near(split('IN').in.known, .010299956639812);
  near(split('B').out.known, .010299956639812 + 10 * Math.log10(.75));
  near(split('TAP').out.known, .010299956639812 + 10 * Math.log10(.25));
  near(mux.at(endpoint('B','wdm','COM'))!.in.known, .010299956639812 + 10 * Math.log10(.75) - 1);
  assert.equal(mux.at(endpoint('A','wdm','COM'))!.in.known.availability, 'unavailable');
});

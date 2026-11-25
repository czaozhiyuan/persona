import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import type { Project } from '../../src/model/v1/types';
import { groupModule } from '../../src/state/v1/group-module';
import { pasteModule } from '../../src/state/v1/instantiate-module';
import { moveInstance } from '../../src/state/v1/reparent-instance';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { duplexFixture } from './fixtures/bidirectional-optics';

const com = (instanceId: string) => ({ instanceId, portId: 'COM' });

test('a COM source leaves on its transmitting side and only external light can feed its receive transfer', () => {
  const p = duplexFixture();
  const router = p.componentDefinitions.find(d => d.id === 'router-A')!;
  router.ports = router.ports.map(port => port.id === 'COM'
    ? { ...port, opticalEmitter: { powerDbm: { kind: 'fixed', value: 10 } } } : port);
  const localSource = { instancePath: ['A', 'router'], portId: 'COM' };
  const remoteSource = { instancePath: ['B', 'laser'], portId: 'OUT' };
  const pd = (box: string) => ({ instancePath: [box, 'pd'], portId: 'IN' });
  const verify = (project: Project, from: typeof localSource, to: typeof localSource, channelId: 'DWDM_CH28' | 'DWDM_CH30', expected?: number) => {
    const resolver = createPathResolver(project), budget = createOpticalBudget(project);
    const named = resolver.resolveNamedLink({ id: 'check', name: 'Check', from, to, channelId });
    const local = budget.calculateLocal({ source: { endpoint: from, channelId }, to });
    if (expected === undefined) {
      assert.equal(named.status, 'unreachable');
      assert.equal(local.pathIssue?.status, 'unreachable');
      assert.equal(local.powerDbm.availability, 'unavailable');
    } else {
      assert.equal(named.status, 'resolved');
      const received = { unit: 'dBm', availability: 'available', value: expected };
      assert.deepEqual(budget.calculateSourcePath(named.trace).powerDbm, received);
      assert.deepEqual(local.powerDbm, received);
    }
  };
  verify(p, localSource, pd('B'), 'DWDM_CH28', 8);
  verify(p, remoteSource, pd('A'), 'DWDM_CH30', 7);
  p.moduleDefinitions[0].cableBundles = [];
  verify(parseProjectJson(serializeProjectJson({ ...p, namedLinks: [] })), localSource, pd('A'), 'DWDM_CH30');
  const passive = duplexFixture();
  const request = { from: localSource, to: pd('A'), channelId: 'DWDM_CH30' as const };
  const trace = createPathResolver(passive).resolveLocalPath(request);
  assert.equal(trace.status, 'resolved');
  const trial = { endpoint: localSource, channelId: request.channelId, powerDbm: 10 };
  assert.equal(createOpticalBudget(passive).calculateSourcePath(trace.trace, trial).pathIssue?.status, 'unreachable');
});

test('one MPO fibre or connection carries both directions through public COM mappings, once per budget', () => {
  const fixture = duplexFixture();
  const [root, ...boxes] = fixture.moduleDefinitions;
  const wire = { ...fixture, moduleDefinitions: [{ ...root, cableBundles: [],
    connections: [{ id: 'fibre', from: com('A'), to: com('B') }] }, ...boxes],
  namedLinks: fixture.namedLinks!.map(link => ({ ...link, via: [{ scopePath: [], connectionId: 'fibre' }] })) };
  for (const project of [fixture, wire]) {
    const saved = parseProjectJson(serializeProjectJson(project));
    const { graph, resolveNamedLink } = createPathResolver(saved);
    const { calculateSourcePath } = createOpticalBudget(saved);
    const physical = graph.edges.filter(edge => edge.source.kind === 'cableCore'
      || (edge.source.kind === 'connection' && edge.source.ref.connectionId === 'fibre'));
    assert.equal(physical.length, 2);
    for (const link of saved.namedLinks!) {
      const path = resolveNamedLink(link);
      assert.equal(path.status, 'resolved');
      assert.equal(path.trace.edges.filter(e => physical.includes(e)).length, 1);
      assert.equal(path.trace.edges.filter(e => e.source.kind === 'portMapping').length, 2);
      assert.ok(path.trace.steps.every(step => step.channelIds?.[0] === link.channelId));
      const result = calculateSourcePath(path.trace);
      assert.deepEqual(result.powerDbm, { unit: 'dBm', availability: 'available', value: 7 });
      assert.deepEqual(result.stages.filter(s => s.endpoint.portId === 'COM').map(s => s.flow), ['out', 'out', 'in', 'in']);
      const other = link.channelId === 'DWDM_CH28' ? 'DWDM_CH30' : 'DWDM_CH28';
      assert.equal(resolveNamedLink({ ...link, channelId: other }).status, 'unreachable');
      const boundary = {
        ...link, from: { instancePath: link.from!.instancePath.slice(0, 1), portId: 'COM' },
        to: { instancePath: link.to!.instancePath.slice(0, 1), portId: 'COM' },
      };
      const observed = resolveNamedLink(boundary);
      assert.equal(observed.status, 'resolved');
      assert.equal(observed.trace.edges.length, 1);
      assert.ok(physical.includes(observed.trace.edges[0]));
      const observation = calculateSourcePath(observed.trace);
      assert.equal(observation.pathIssue, undefined);
      assert.deepEqual(observation.stages.map(s => s.flow), ['out', 'in']);
      assert.equal(observation.powerDbm.availability, 'unavailable');
      assert.equal(resolveNamedLink(boundary, { opticalSources: [boundary.from] }).status, 'unreachable');
    }
  }
  const withSpare = { ...fixture, moduleDefinitions: [{ ...root,
    instances: [...root.instances, { id: 'spare', name: '备用', definitionId: 'pd' }] }, ...boxes] };
  const grouped = groupModule(withSpare, [['A'], ['spare']], '光模块', 'group', 'group-def');
  const boundary = grouped.moduleDefinitions.find(m => m.id === 'group-def')!.ports[0];
  assert.deepEqual([boundary.direction, boundary.side], ['bidirectional', 'top']);
  assert.equal(createPathResolver(parseProjectJson(serializeProjectJson(grouped))).resolveNamedLink(grouped.namedLinks![0]).status, 'resolved');
  let next = 0;
  const copied = pasteModule(fixture, fixture, ['A'], [], 'copy', () => 'copy-' + ++next);
  const moved = parseProjectJson(serializeProjectJson(moveInstance(copied, ['copy'], ['B'])));
  const copy = resolveHierarchy(moved).resolveInstance(['B', 'copy'])!.definition;
  assert.deepEqual(copy.ports, boxes[0].ports);
  assert.ok(copy.kind === 'module' && copy.portMappings?.[0].target.portId === 'COM');
});

test('declared one-way transfers stay directional and a genuine same-wavelength loop is diagnosed', () => {
  const project = duplexFixture();
  const [root, ...boxes] = project.moduleDefinitions;
  const components: Project['componentDefinitions'] = project.componentDefinitions.map(def => !def.id.startsWith('router-') ? def : {
    ...def, ports: def.ports.map(port => ({ ...port, direction: 'bidirectional' })),
    transfers: def.transfers?.map(t => ({ ...t, channelIds: ['DWDM_CH28'] })),
  });
  const resolver = createPathResolver({ ...project, componentDefinitions: components });
  const router = ['A', 'router'];
  const local = (a: string, b: string) => resolver.resolveLocalPath({
    from: { instancePath: router, portId: a }, to: { instancePath: router, portId: b }, channelId: 'DWDM_CH28' });
  assert.equal(local('TX', 'COM').status, 'resolved');
  assert.equal(local('COM', 'TX').status, 'unreachable');
  const loop = { ...project, componentDefinitions: components, moduleDefinitions: [root, ...boxes.map(box => ({ ...box,
    connections: [...box.connections!, { id: 'return', from: { instanceId: 'router', portId: 'RX' },
      to: { instanceId: 'router', portId: 'TX' } }],
  }))] };
  assert.equal(createPathResolver(loop).resolveNamedLink(project.namedLinks![0]).status, 'feedback_loop');
});

test('optical wiring rejects reversed duplicates, incompatible channels and bidirectional electrical ports', () => {
  const project = duplexFixture();
  const [root, ...boxes] = project.moduleDefinitions;
  assert.throws(() => serializeProjectJson({ ...project, moduleDefinitions: [{ ...root,
    connections: [{ id: 'duplicate', from: com('B'), to: com('A') }] }, ...boxes] }), /重复连接/);
  assert.throws(() => serializeProjectJson({ ...project, moduleDefinitions: [root, ...boxes.map((box, i) => ({ ...box,
    ports: box.ports.map(p => ({ ...p, channelIds: [i ? 'DWDM_CH30' : 'DWDM_CH28'] as const })) }))] }), /共同的光通道/);
  for (const type of ['RF', 'CONTROL', 'DC_POWER', 'AC_POWER'] as const) {
    assert.throws(() => serializeProjectJson({ ...project, moduleDefinitions: [{ ...root,
      ports: [{ id: 'invalid', type, direction: 'bidirectional' }] }, ...boxes] }), /方向/);
  }
});

test('two same-channel sources sharing an MPO supply remain ambiguous until the source is selected', () => {
  const project = duplexFixture();
  const [root, a, b] = project.moduleDefinitions;
  const withSources: Project = { ...project, componentDefinitions: project.componentDefinitions.map(def => def.id !== 'pd' ? def : {
    ...def, ports: [...def.ports, { id: 'RF', type: 'RF', direction: 'in' }, { id: 'OUT', type: 'OPTICAL', direction: 'out' }],
    transfers: [{ kind: 'eo', fromPortId: 'RF', toPortId: 'OUT', supplyPortId: 'IN', insertionLossDb: { kind: 'fixed', value: 0 } }],
  }), moduleDefinitions: [root, { ...a, instances: [...a.instances, { id: 'second', name: '第二光源', definitionId: 'laser' }],
    connections: [...a.connections!, { ...a.connections![0], id: 'second', from: { instanceId: 'second', portId: 'OUT' } }] }, b] };
  const local = createOpticalBudget(withSources).calculateLocal;
  const query = { eo: { instancePath: ['B', 'pd'], fromPortId: 'RF', toPortId: 'OUT' },
    to: { instancePath: ['B', 'pd'], portId: 'OUT' }, channelId: 'DWDM_CH28' } as const;
  assert.equal(local({ ...query, sources: [] }).pathIssue?.status, 'ambiguous');
  const selected = local({ ...query, sources: [{ endpoint: { instancePath: ['A', 'second'], portId: 'OUT' } }] });
  assert.equal(selected.status, 'valid');
  assert.equal(selected.stages[0].endpoint.instancePath.at(-1), 'second');
});

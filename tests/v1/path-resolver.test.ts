import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import type { OpticalChannelId } from '../../src/model/v1/channels';
import { deviceExample } from '../../src/model/v1/device-example';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { NamedLink } from '../../src/model/v1/topology';
import type { EndpointRef, InstancePath, ModuleDefinition, PortDirection, Project } from '../../src/model/v1/types';

const ch28 = 'DWDM_CH28' as const, ch30 = 'DWDM_CH30' as const;
const endpoint = (instancePath: InstancePath, portId: string): EndpointRef => ({ instancePath, portId });
const optical = (id: string, direction: PortDirection, ...channelIds: OpticalChannelId[]) =>
  ({ id, type: 'OPTICAL' as const, direction, ...(channelIds.length > 0 && { channelIds }) });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });

function deepTopology() {
  const [root, tx, rx] = topologyExample.moduleDefinitions;
  const mzm = topologyExample.componentDefinitions[1];
  const wrappers = ['slot', 'cbb', 'shell'];
  const modules: ModuleDefinition[] = wrappers.map((id, index) => ({
    kind: 'module', id, name: id, ports: mzm.ports,
    instances: [{ id: 'child', name: 'Child', definitionId: wrappers[index + 1] ?? 'mzm' }],
    portMappings: mzm.ports.map(port => ({ portId: port.id, target: local('child', port.id) })),
  }));
  const original = topologyExample.namedLinks[2];
  const leafPath = ['TX_A', 'mzm', 'child', 'child', 'child'];
  const link: NamedLink = {
    ...original,
    conversionBindings: original.conversionBindings!.map(binding => ({
      ...binding, eo: { ...binding.eo, instancePath: leafPath },
    })),
  };
  const project: Project = {
    ...topologyExample, namedLinks: [link],
    componentDefinitions: [...topologyExample.componentDefinitions, {
      kind: 'component', id: 'laser', name: 'Laser', ports: [optical('OUT', 'out', ch28)],
    }],
    moduleDefinitions: [root, {
      ...tx,
      instances: [...tx.instances.map(instance => instance.id === 'mzm' ? { ...instance, definitionId: 'slot' } : instance),
        { id: 'laser1', name: 'Laser', definitionId: 'laser' }, { id: 'laser2', name: 'Laser', definitionId: 'laser' }],
      connections: [...tx.connections!,
        { id: 'supply1', from: local('laser1', 'OUT'), to: local('mzm', 'SUPPLY') },
        { id: 'supply2', from: local('laser2', 'OUT'), to: local('mzm', 'SUPPLY') }],
    }, {
      ...rx, portMappings: [{ portId: 'OPT_IN', target: local('pd', 'IN') }],
    }, ...modules],
  };
  return { project, link, leafPath, laser1: endpoint(['TX_A', 'laser1'], 'OUT'), laser2: endpoint(['TX_A', 'laser2'], 'OUT') };
}

test('a cross-chassis route traces six object levels, a fibre, EO/OE and their calibration binding', () => {
  const { project, link, leafPath, laser1 } = deepTopology();
  const { resolveNamedLink, resolveLocalPath } = createPathResolver(project);
  const options = { opticalSources: [laser1] };
  const result = resolveNamedLink(link, options);
  assert.equal(result.status, 'resolved');
  assert.ok(result.trace.edges.some(edge => edge.source.kind === 'cableCore' && edge.source.ref.coreId === 'wdm'));
  assert.deepEqual(result.trace.edges.filter(edge => edge.source.kind === 'portMapping'
    && edge.from.ref.portId === 'OUT').map(edge => edge.from.ref.instancePath.length), [5, 4, 3, 2]);
  const [eo, oe] = result.trace.conversions;
  assert.deepEqual(result.trace.steps[eo.edgeIndex].port.ref, endpoint(leafPath, 'RF_IN'));
  assert.deepEqual(result.trace.steps[oe.edgeIndex].channelIds, [ch28]);
  assert.deepEqual(result.trace.bindings, [
    { binding: link.conversionBindings![0], eoEdgeIndex: eo.edgeIndex, oeEdgeIndex: oe.edgeIndex, matched: true },
  ]);
  const [supply] = result.trace.supplies;
  assert.equal(supply.status, 'resolved');
  assert.deepEqual(supply.path.steps[0].port.ref, laser1);
  assert.deepEqual(supply.path.steps.at(-1)?.port.ref, endpoint(leafPath, 'SUPPLY'));

  assert.equal(resolveNamedLink({ ...link, via: [{ scopePath: ['TX_B'], connectionId: 'rf-feed' }] }, options).status, 'unreachable');
  assert.equal(resolveLocalPath({ from: link.from!, to: endpoint(['TX_A'], 'OPT_OUT'), channelId: ch28 }, options).status, 'resolved');
  const boundaries = resolveNamedLink({ id: 'optical', name: 'Optical',
    from: endpoint(['TX_A'], 'OPT_OUT'), to: endpoint(['RX_A'], 'OPT_IN'), channelId: ch28 });
  assert.equal(boundaries.status, 'resolved');
  assert.deepEqual(boundaries.trace.steps[0].port.ref, endpoint(leafPath, 'OUT'));
  assert.deepEqual(boundaries.trace.steps.at(-1)?.port.ref, endpoint(['RX_A', 'pd'], 'IN'));
});

test('a selected EO route reports missing, incompatible or ambiguous optical supply', () => {
  const { project, link, laser1, laser2 } = deepTopology();
  const { resolveNamedLink } = createPathResolver(project);
  assert.equal(resolveNamedLink(link).trace?.supplies[0].status, 'missing');
  const wrongCarrier = resolveNamedLink({ ...link, channelId: ch30 }, { opticalSources: [laser1] });
  assert.equal(wrongCarrier.status, 'unreachable');
  assert.equal(wrongCarrier.trace?.supplies[0].status, 'missing');
  const multi = resolveNamedLink(link, { opticalSources: [laser1, laser2] });
  assert.equal(multi.status, 'ambiguous');
  assert.equal(multi.trace?.supplies[0].status, 'ambiguous');
  const inferredCarrier = resolveNamedLink({ ...link, channelId: undefined }, { opticalSources: [laser1] });
  assert.equal(inferredCarrier.status, 'resolved');
  assert.ok(inferredCarrier.trace.steps.every(step => step.port.definition.type !== 'OPTICAL'
    || (step.channelIds?.length === 1 && step.channelIds[0] === ch28)));
});

function branchingProject(loop: 'none' | 'dead' | 'relevant' = 'none'): Project {
  return {
    id: 'branches', name: 'Branches', rootModuleDefinitionId: 'system',
    componentDefinitions: [
      { kind: 'component', id: 'src', name: 'Source', ports: [optical('OUT', 'out')] },
      { kind: 'component', id: 'sink', name: 'Sink', ports: [optical('IN', 'in')] },
      ...[ch28, ch30].map(channelId => ({
        kind: 'component' as const, id: channelId, name: channelId,
        ports: [optical('IN', 'in', channelId), optical('OUT', 'out', channelId)],
        transfers: [{ kind: 'optical' as const, fromPortId: 'IN', toPortId: 'OUT' }],
      })),
    ],
    moduleDefinitions: [{
      kind: 'module', id: 'system', name: 'System', ports: [],
      instances: [
        { id: 'src', name: 'Source', definitionId: 'src' }, { id: 'sink', name: 'Sink', definitionId: 'sink' },
        { id: 'a', name: 'CH28 relay', definitionId: ch28 }, { id: 'b', name: 'CH30 relay', definitionId: ch30 },
      ],
      connections: [
        { id: 'toA', from: local('src', 'OUT'), to: local('a', 'IN') },
        { id: 'toB', from: local('src', 'OUT'), to: local('b', 'IN') },
        { id: 'fromA', from: local('a', 'OUT'), to: local('sink', 'IN') },
        ...(loop !== 'dead' ? [{ id: 'fromB', from: local('b', 'OUT'), to: local('sink', 'IN') }] : []),
        ...(loop !== 'none' ? [{ id: 'feedback', from: local('b', 'OUT'), to: local('b', 'IN') }] : []),
      ],
    }],
  };
}

const branched: NamedLink = {
  id: 'branch', name: 'Branch', from: endpoint(['src'], 'OUT'), to: endpoint(['sink'], 'IN'),
};

test('channel or required edge resolves ambiguity, and only relevant feedback blocks a query', () => {
  const { resolveNamedLink } = createPathResolver(branchingProject());
  assert.equal(resolveNamedLink(branched).status, 'ambiguous');
  const selected = resolveNamedLink({ ...branched, channelId: ch28 });
  assert.equal(selected.status, 'resolved');
  assert.deepEqual(selected.trace.steps.map(step => step.channelIds), [[ch28], [ch28], [ch28], [ch28]]);
  const required = resolveNamedLink({ ...branched, via: [{ scopePath: [], connectionId: 'fromB' }] });
  assert.equal(required.status, 'resolved');
  assert.deepEqual(required.trace.steps[0].channelIds, [ch30]);
  assert.equal(resolveNamedLink({ ...branched, channelId: 'MM850' }).status, 'unreachable');
  assert.equal(createPathResolver(branchingProject('dead')).resolveNamedLink(branched).status, 'resolved');
  const feedback = createPathResolver(branchingProject('relevant')).resolveNamedLink(branched);
  assert.equal(feedback.status, 'feedback_loop');
  assert.deepEqual(feedback.endpoint?.instancePath, ['b']);
});

test('drafts, missing mappings, bad references and physical disconnection have separate diagnostics', () => {
  const { resolveNamedLink } = createPathResolver(topologyExample);
  const link = topologyExample.namedLinks[2];
  assert.equal(resolveNamedLink(topologyExample.namedLinks[0]).status, 'incomplete');
  const open = resolveNamedLink(link);
  assert.equal(open.status, 'incomplete');
  assert.deepEqual(open.endpoint, endpoint(['RX_A'], 'OPT_IN'));
  assert.equal(resolveNamedLink({ ...link, to: endpoint(['RX_A', 'pd'], 'nonexistent') }).status, 'invalid_reference');
  assert.equal(resolveNamedLink({ ...link, via: [{ scopePath: [], bundleId: 'mpo-12', coreId: 'not-a-core' }] }).status, 'invalid_reference');
  assert.equal(resolveNamedLink({ ...link, via: [{ scopePath: [], bundleId: 'mpo-12', coreId: 'open' }] }).status, 'unreachable');
  const disconnected = resolveNamedLink({ ...link, to: endpoint(['RX_B', 'pd'], 'RF_OUT'), via: [] });
  assert.equal(disconnected.status, 'unreachable');
});

test('explicit local ports follow the selected switch state without a named link', () => {
  const request = { from: endpoint(['swA'], 'IN'), to: endpoint(['swA'], 'OUT_A'), channelId: ch28 };
  assert.equal(createPathResolver(deviceExample).resolveLocalPath(request).status, 'resolved');
  const switched: Project = {
    ...deviceExample,
    moduleDefinitions: deviceExample.moduleDefinitions.map(module => ({
      ...module, instances: module.instances.map(instance => instance.id === 'swA' ? { ...instance, switchStateId: 'b' } : instance),
    })),
  };
  assert.equal(createPathResolver(switched).resolveLocalPath(request).status, 'unreachable');
  assert.equal(createPathResolver(switched).resolveLocalPath({ ...request, to: endpoint(['swA'], 'OUT_B') }).status, 'resolved');
});

test('an explicit wavelength conversion changes only the optical span after it', () => {
  const project = branchingProject();
  const converted: Project = {
    ...project,
    componentDefinitions: project.componentDefinitions.map(component => component.id === ch28 ? {
      ...component, ports: [optical('IN', 'in', ch28), optical('OUT', 'out', ch30)],
      transfers: [{ kind: 'wavelengthConversion', fromPortId: 'IN', toPortId: 'OUT', fromChannelId: ch28, toChannelId: ch30 }],
    } : component),
  };
  const { resolveNamedLink } = createPathResolver(converted);
  const via = [{ scopePath: [], connectionId: 'fromA' }];
  const result = resolveNamedLink({ ...branched, via, channelId: ch28 });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.trace.steps.map(step => step.channelIds), [[ch28], [ch28], [ch30], [ch30]]);
  assert.equal(resolveNamedLink({ ...branched, via, channelId: ch30 }).status, 'unreachable');
});

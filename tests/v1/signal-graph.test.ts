import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSignalGraph, signalPortKey } from '../../src/engine/v1/signal-graph';
import { deviceExample } from '../../src/model/v1/device-example';
import { exampleProject } from '../../src/model/v1/example';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { EndpointRef, InstancePath, Project } from '../../src/model/v1/types';

const ch28 = 'DWDM_CH28';
const ch30 = 'DWDM_CH30';
const endpoint = (instancePath: InstancePath, portId: string): EndpointRef => ({ instancePath, portId });

test('MPO cores retain physical pins, signal direction, and distinct WDM carriers', () => {
  const graph = buildSignalGraph(topologyExample);
  const cores = graph.edges.filter(edge => edge.source.kind === 'cableCore');
  assert.deepEqual(cores.map(({ from, to, source, channels }) => ({
    from: from.ref, to: to.ref, source, channels,
  })), [
    {
      from: endpoint(['TX_A'], 'OPT_OUT'), to: endpoint(['RX_A'], 'OPT_IN'),
      source: { kind: 'cableCore', ref: { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }, aPin: 1, bPin: 12 },
      channels: { kind: 'preserve', channelIds: [ch28, ch30] },
    },
    {
      from: endpoint(['RX_A'], 'RETURN_OUT'), to: endpoint(['TX_A'], 'RETURN_IN'),
      source: { kind: 'cableCore', ref: { scopePath: [], bundleId: 'mpo-12', coreId: 'return' }, aPin: 2, bPin: 11 },
      channels: { kind: 'preserve', channelIds: [ch28, ch30] },
    },
  ]);
  assert.ok(graph.ports.has(signalPortKey(endpoint(['TX_A'], 'TEST_OUT'))));
  assert.equal(graph.ports.get(signalPortKey(endpoint(['RX_A'], 'OPT_IN')))?.unmapped, true);

  const connections = graph.edges.flatMap(edge => edge.source.kind === 'connection' ? [edge.source] : []);
  assert.deepEqual(connections.filter(edge => edge.ref.connectionId === 'rf-feed').map(edge => edge.ref.scopePath),
    [['TX_A'], ['TX_B']]);
  const control = graph.edges.find(edge => edge.source.kind === 'connection' && edge.source.mediaKind === 'RJ45_CABLE');
  assert.equal(control?.from.definition.type, 'CONTROL');
  assert.equal(control?.to.definition.type, 'CONTROL');
  assert.deepEqual(control?.channels, { kind: 'none' });
});

test('module mappings are directional and EO declares an independent same-channel supply input', () => {
  const project: Project = {
    ...topologyExample,
    moduleDefinitions: topologyExample.moduleDefinitions.map(module => module.id === 'rx' ? {
      ...module, portMappings: [{ portId: 'OPT_IN', target: { instanceId: 'pd', portId: 'IN' } }],
    } : module),
    componentDefinitions: topologyExample.componentDefinitions.map(component => component.id === 'mzm' ? {
      ...component, ports: component.ports.map(port => port.id === 'SUPPLY' ? { ...port, channelIds: [ch30] } : port),
    } : component),
  };
  const graph = buildSignalGraph(project);
  const maps = graph.edges.filter(edge => edge.source.kind === 'portMapping');
  assert.ok(maps.some(({ from, to, channels }) => from.ref.portId === 'OUT' && to.ref.portId === 'OPT_OUT'
    && from.ref.instancePath[0] === 'TX_A' && channels.kind === 'preserve' && channels.channelIds?.includes(ch28)));
  assert.ok(maps.some(({ from, to }) => from.ref.portId === 'OPT_IN' && to.ref.portId === 'IN'
    && from.ref.instancePath[0] === 'RX_A'));
  assert.equal(graph.ports.get(signalPortKey(endpoint(['RX_A'], 'OPT_IN')))?.unmapped, false);

  const path = ['TX_A', 'mzm'];
  const eo = graph.edges.find(edge => edge.from.ref.portId === 'RF_IN' && edge.from.ref.instancePath[0] === 'TX_A');
  assert.deepEqual(eo?.from.ref, endpoint(path, 'RF_IN'));
  assert.deepEqual(eo?.to.ref, endpoint(path, 'OUT'));
  assert.deepEqual(eo?.supply?.ref, endpoint(path, 'SUPPLY'));
  assert.deepEqual(eo?.channels, { kind: 'enter', channelIds: [ch30] });
  assert.equal(graph.edges.some(edge => edge.from === eo?.supply), false);
  const oe = graph.edges.find(edge => edge.source.kind === 'transfer' && edge.source.transfer.kind === 'oe');
  assert.equal(oe?.channels.kind, 'exit');
});

test('instance switch selection and declared MUX/DEMUX channels determine device edges', () => {
  const graph = buildSignalGraph(deviceExample);
  const switchEdges = (value: typeof graph) => value.edges.filter(edge => edge.source.kind === 'switchRoute');
  const routes = switchEdges(graph);
  assert.deepEqual(routes.map(edge => [edge.from.ref.instancePath[0], edge.to.ref.portId]), [
    ['swA', 'OUT_A'], ['swB', 'OUT_B'],
  ]);
  const switched: Project = {
    ...deviceExample,
    moduleDefinitions: deviceExample.moduleDefinitions.map(module => ({
      ...module, instances: module.instances.map(instance => instance.id === 'swA' ? { ...instance, switchStateId: 'b' } : instance),
    })),
  };
  const after = switchEdges(buildSignalGraph(switched));
  assert.equal(after[0].to.ref.portId, 'OUT_B');
  assert.deepEqual(after[1], routes[1]);
  assert.equal(after[0].source.kind === 'switchRoute' && after[0].source.route.gainDb?.kind, 'channelTable');

  const route = (instance: string, from: string, to: string) => graph.edges.find(edge =>
    edge.from.ref.instancePath[0] === instance && edge.from.ref.portId === from && edge.to.ref.portId === to);
  assert.deepEqual(route('mux', 'IN_28', 'COMMON')?.channels, { kind: 'preserve', channelIds: [ch28] });
  assert.deepEqual(route('demux', 'COMMON', 'OUT_30')?.channels, { kind: 'preserve', channelIds: [ch30] });
  assert.equal(route('board', 'RX_IN', 'TX_OUT'), undefined);
  assert.equal(graph.edges.some(edge => edge.from.ref.instancePath.includes('RX_850')
    && edge.to.ref.instancePath.includes('TX_CH30')), false);
  assert.deepEqual(graph.instances.find(instance => instance.instancePath.at(-1) === 'mzm')?.parameters.get('modulatorGain')?.value,
    { kind: 'fixed', value: -4 });
});

test('only an explicit converter changes an optical channel and DC stays in its domain', () => {
  const project: Project = {
    id: 'typed', name: 'Typed signals', rootModuleDefinitionId: 'system',
    moduleDefinitions: [{ kind: 'module', id: 'system', name: 'System', ports: [],
      instances: [{ id: 'adapter', name: 'Adapter', definitionId: 'adapter' }] }],
    componentDefinitions: [{
      kind: 'component', id: 'adapter', name: 'Adapter',
      ports: [
        { id: 'IN', type: 'OPTICAL', direction: 'in', channelIds: [ch28] },
        { id: 'OUT', type: 'OPTICAL', direction: 'out', channelIds: [ch30] },
        { id: 'DC_IN', type: 'DC_POWER', direction: 'in' }, { id: 'DC_OUT', type: 'DC_POWER', direction: 'out' },
      ],
      transfers: [
        { kind: 'wavelengthConversion', fromPortId: 'IN', toPortId: 'OUT', fromChannelId: ch28, toChannelId: ch30 },
        { kind: 'dc', fromPortId: 'DC_IN', toPortId: 'DC_OUT' },
      ],
    }],
  };
  const { edges } = buildSignalGraph(project);
  assert.deepEqual(edges.map(edge => [edge.from.definition.type, edge.to.definition.type, edge.channels]), [
    ['OPTICAL', 'OPTICAL', { kind: 'convert', fromChannelId: ch28, toChannelId: ch30 }],
    ['DC_POWER', 'DC_POWER', { kind: 'none' }],
  ]);
});

test('all instances and mapped ports are visited without using layout coordinates', () => {
  const original = buildSignalGraph(exampleProject);
  const withoutLayout = buildSignalGraph({ ...exampleProject, layout: undefined });
  assert.deepEqual(withoutLayout, original);
  assert.equal(original.instances.length, 11);
  assert.equal(original.edges.length, 8);
  assert.ok(original.ports.has(signalPortKey(endpoint(['TX_B', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'], 'OPT_OUT'))));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMultiplexPower } from '../../src/engine/v1/multiplex-power';
import { createOpticalBudgetForGraph } from '../../src/engine/v1/optical-budget';
import { signalPortKey } from '../../src/engine/v1/signal-graph';
import { createLinkOptions } from '../../src/workbench/v1/links/link-options';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { controlPin, inputs, outputs, sharedChannel, sharedDigitalProject } from './fixtures/nested-digital-project';

test('nested CONTROL fan-in and fan-out expose nine reachable combinations without pairing or reserving endpoints', () => {
  const project = sharedDigitalProject(), links = project.namedLinks!;
  const options = createLinkOptions(project);
  const initial = options.endpointChoices('', sharedChannel, false);
  const keys = (box: string, pins: string[]) => pins.map(id => signalPortKey(controlPin(box, id)));
  assert.deepEqual(initial.from.map(p => p.key), [...keys('A', inputs), ...keys('B', inputs)]);
  assert.deepEqual(initial.to.map(p => p.key), [...keys('A', outputs), ...keys('B', outputs)]);
  for (const input of inputs) {
    const from = controlPin('A', input);
    assert.deepEqual(options.endpointChoices(signalPortKey(from), sharedChannel, false).to.map(p => p.key), keys('B', outputs));
    for (const output of outputs) {
      const route = options.resolveNamedLink({ ...links[0], from, to: controlPin('B', output) });
      assert.equal(route.status, 'resolved');
      const branches = route.trace.edges.filter(edge => edge.source.kind === 'transfer' && edge.source.transfer.kind === 'control');
      assert.deepEqual(branches.map(e => [e.from.ref, e.to.ref]), [
        [from, controlPin('A', 'TTL OUT')], [controlPin('B', 'TTL IN'), controlPin('B', output)],
      ]);
    }
  }
  assert.equal(links.length, 3);
  const reverse = { ...links[0], from: controlPin('B', inputs[0]), to: controlPin('A', outputs[2]), channelId: 'CWDM_1371' as const };
  assert.equal(options.resolveNamedLink(reverse).status, 'resolved');
  const local = options.resolveNamedLink({ ...links[0], to: controlPin('A', 'TTL OUT'), channelId: undefined });
  assert.equal(local.status, 'resolved');
  assert.ok(local.trace.steps.every(step => step.port.definition.type === 'CONTROL'));
  const card = project.moduleDefinitions.find(m => m.id === 'card')!;
  card.instances = [...card.instances, { id: 'relay', name: 'Relay', definitionId: 'logic' }];
  card.connections = [...card.connections!,
    { id: 'split', from: { instanceId: 'ctl', portId: 'TTL OUT' }, to: { instanceId: 'relay', portId: inputs[0] } },
    { id: 'alternate', from: { instanceId: 'relay', portId: 'TTL OUT' }, to: { instanceId: 'io', portId: 'a' } }];
  const parallel = createLinkOptions(project);
  assert.equal(parallel.resolveNamedLink(links[0]).status, 'ambiguous');
  assert.equal(parallel.resolveNamedLink({ ...links[0], via: [{ scopePath: ['A', 'card'], connectionId: 'alternate' }] }).status, 'resolved');
});

test('three named links share one physical launch and independently track loss, receiver settings and disconnections', () => {
  const project = parseProjectJson(serializeProjectJson(sharedDigitalProject()));
  const [root] = project.moduleDefinitions, [logic] = project.componentDefinitions, links = project.namedLinks!;
  const ref = (box: string, portId: string) => ({ instancePath: [box, 'card', 'io', 'device'], portId });
  function check(loss: number, broken: string[] = [], tx = 0, sensitivity = -20) {
    const { graph, resolveNamedLink } = createLinkOptions(project);
    const power = createMultiplexPower(graph), optics = createOpticalBudgetForGraph(graph);
    const launch = power.at({ instancePath: ['A', 'wdm'], portId: 'COM' })!;
    assert.deepEqual(launch.out.known, { availability: 'available', unit: 'dBm', value: tx });
    assert.deepEqual(launch.waves.find(w => w.flow === 'out' && w.channelId === sharedChannel)?.sources, [ref('A', 'OPT_TX_OUT')]);
    for (const link of project.namedLinks!) {
      const route = resolveNamedLink(link);
      if (broken.includes(link.id)) {
        assert.equal(route.status, 'unreachable');
        assert.ok(route.digitalAccess?.length);
        continue;
      }
      assert.equal(route.status, 'resolved');
      const budget = optics.calculateDigitalPath(route.trace, sharedChannel)!;
      assert.equal(budget.status, 'valid');
      assert.deepEqual(budget.stages.at(-1)?.endpoint, ref('B', 'OPT_RX_IN'));
      assert.deepEqual(budget.powerDbm, { availability: 'available', unit: 'dBm', value: tx - loss });
      assert.deepEqual(budget.digitalReceiver?.margin, { availability: 'available', unit: 'dB', value: tx - loss - sensitivity });
      assert.equal(budget.digitalReceiver?.aboveLimit, tx - loss > 0);
    }
  }
  check(3);
  project.namedLinks = links.slice(1);
  check(3);
  project.namedLinks = [];
  check(3);
  project.namedLinks = links;
  const physical = root.connections!.map(wire => ({ ...wire, lossDb: 6 }));
  root.connections = physical;
  check(6);
  const routes = logic.transfers!;
  logic.transfers = routes.filter(t => t.fromPortId !== inputs[0]);
  check(6, [links[0].id]);
  logic.transfers = routes;
  root.connections = [];
  check(6, links.map(link => link.id));
  root.connections = physical;
  check(6);
  project.instanceSettings = [...project.instanceSettings!,
    { instancePath: ref('A', '').instancePath, parameterOverrides: { power: { kind: 'fixed', value: 7 } } },
    { instancePath: ref('B', '').instancePath, parameterOverrides: { sensitivity: { kind: 'fixed', value: -23 } } }];
  check(6, [], 7, -23);
});

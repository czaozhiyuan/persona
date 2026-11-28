import assert from 'node:assert/strict';
import test from 'node:test';
import { controlNetworks, type ControlRoute } from '../../src/editors/topology/v1/control-networks';
import type { PortDefinition } from '../../src/model/v1/types';

test('internal networks follow wired input order and keep same-color drivers of one output independent', () => {
  const port = (id: string, direction: 'in' | 'out'): PortDefinition => ({ id, direction, type: 'CONTROL' });
  const inputs = Array.from({ length: 8 }, (_, i) => port('input-' + i, 'in'));
  const outputs = Array.from({ length: 7 }, (_, i) => port('output-' + i, 'out'));
  const wired = inputs.filter((_, i) => i !== 1);
  const route = (from: PortDefinition, to: PortDefinition): ControlRoute => ({ kind: 'control', fromPortId: from.id, toPortId: to.id });
  const routes = wired.map((p, i) => route(p, outputs[6 - i])).reverse();
  routes.push(route(wired[0], outputs[0]));
  for (const organize of [false, true]) {
    const { networks } = controlNetworks(inputs, outputs, routes, organize);
    assert.deepEqual(networks.map(n => n.input), wired.map(p => p.id));
    assert.deepEqual(networks.map(n => n.color), ['#2564ad', '#ba531b', '#167768', '#7556ad', '#ac3f68', '#806716', '#2564ad']);
    assert.deepEqual(networks.map(n => n.junctions.length), [1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(networks[0].branches.map(b => b.output), [outputs[0].id, outputs[6].id]);
    const sameOutput = networks[6].branches[0];
    assert.equal(sameOutput.output, networks[0].branches[0].output);
    assert.notEqual(sameOutput.id, networks[0].branches[0].id);
    assert.notEqual(sameOutput.path, networks[0].branches[0].path);
  }
});

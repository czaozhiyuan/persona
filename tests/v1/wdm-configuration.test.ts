import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factory } from '../../src/library/v1/user-library';
import type { ComponentDefinition } from '../../src/model/v1/types';
import { validateWdm, wdmPort, withWdmPorts } from '../../src/model/v1/wdm';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

test('WDM edits keep terminal IDs and bind both propagation directions to the same loss', () => {
  const original = factory.get('library-wdm') as ComponentDefinition;
  assert.deepEqual(original.ports.map(p => [p.id, p.direction, p.channelIds?.[0]]), [
    ['COM', 'bidirectional', undefined], ['CH1', 'in', 'CWDM_1311'], ['CH2', 'in', 'CWDM_1351'],
    ['CH3', 'out', 'CWDM_1371'], ['CH4', 'out', 'CWDM_1391'],
  ]);
  const [common] = original.ports;
  const tuned = withWdmPorts(original, [common, wdmPort('CH1', 'DWDM_CH31', 'out'), wdmPort('extra', 'CWDM_1551', 'in')]);
  const project = { id: 'p', name: 'P', rootModuleDefinitionId: 'root', componentDefinitions: [tuned],
    moduleDefinitions: [{ id: 'root', kind: 'module' as const, name: 'Root', ports: [], instances: [] }] };
  assert.deepEqual(parseProjectJson(serializeProjectJson(project)).componentDefinitions[0], tuned);
  assert.deepEqual(tuned.transfers, [
    { kind: 'optical', fromPortId: 'COM', toPortId: 'CH1', channelIds: ['DWDM_CH31'], insertionLossDb: { kind: 'parameter', parameterId: 'insertionLoss' } },
    { kind: 'optical', fromPortId: 'extra', toPortId: 'COM', channelIds: ['CWDM_1551'], insertionLossDb: { kind: 'parameter', parameterId: 'insertionLoss' } },
  ]);
  assert.throws(() => validateWdm(withWdmPorts(tuned, [...tuned.ports, wdmPort('dup', 'DWDM_CH31', 'in')])), /重复/);
  assert.throws(() => validateWdm(withWdmPorts(tuned, [common, wdmPort('offgrid', 'CWDM_1310', 'in')])), /标准/);
  assert.throws(() => validateWdm({ ...tuned, transfers: [] }), /统一通道插损/);
});

import { builtInDefinitions } from '../../../src/library/v1/built-in';
import type { OpticalChannelId } from '../../../src/model/v1/channels';
import type { Connection } from '../../../src/model/v1/topology';
import type { ComponentDefinition, Instance, ModuleDefinition, Project } from '../../../src/model/v1/types';
import { withWdmPorts } from '../../../src/model/v1/wdm';

export const fixed = (value: number) => ({ kind: 'fixed' as const, value });
export const wdmChannels = ['CWDM_1311', 'CWDM_1351', 'CWDM_1371', 'CWDM_1391'] as const;
export const local = (instanceId: string, portId: string) => ({ instanceId, portId });
export const endpoint = (box: string, child: string, portId: string) => ({ instancePath: [box, child], portId });
const component = (id: string): ComponentDefinition => structuredClone(builtInDefinitions.find(d => d.id === id)!) as ComponentDefinition;

export function wdmProject(modulated = false): Project {
  const wdm = component('library-wdm');
  const reverse = withWdmPorts({ ...wdm, id: 'wdm-reverse' }, wdm.ports.map(p => p.id === 'COM' ? p
    : { ...p, direction: p.direction === 'in' ? 'out' : 'in' }));
  const root: ModuleDefinition = { id: 'root', kind: 'module', name: '系统', ports: [],
    instances: ['A', 'B'].map(id => ({ id, name: '机箱 ' + id, definitionId: id })),
    connections: [{ id: 'fibre', from: local('A', 'COM'), to: local('B', 'COM'), mediaKind: 'OPTICAL_FIBER', lossDb: 2 }] };
  const namedLinks = wdmChannels.map((channelId: OpticalChannelId, i) => {
    const tx = i < 2 ? 'A' : 'B', rx = i < 2 ? 'B' : 'A';
    const rf = modulated && (i === 0 || i === 2);
    return { id: 'wave' + i, name: tx + ' → ' + rx + ' · ' + channelId, channelId,
      from: endpoint(tx, rf && i === 0 ? 'mzm' : 'wave' + i, rf ? 'RF_IN' : 'OPT_OUT'),
      to: endpoint(rx, 'wave' + i, rf ? 'RF_OUT' : 'OPT_IN') };
  });
  function box(id: string, device: ComponentDefinition): ModuleDefinition {
    const instances: Instance[] = [{ id: 'wdm', name: 'WDM', definitionId: device.id }];
    const connections: Connection[] = [];
    for (const [i, port] of device.ports.filter(p => p.id !== 'COM').entries()) {
      const source = port.direction === 'in', key = 'wave' + i;
      const dml = source && modulated && i === 2;
      instances.push({ id: key, name: source ? '光源 ' + (i + 1) : 'PD ' + (i + 1),
        definitionId: !source ? 'library-pd' : dml ? 'library-dml' : 'library-laser',
        parameterOverrides: source ? dml ? { power: fixed(0), slope: fixed(.02) } : { power: fixed(0) }
          : { receiver: 'external50', responsivity: fixed(.8) } });
      let emitter = key;
      if (modulated && source && i === 0) {
        emitter = 'mzm';
        instances.push({ id: emitter, name: 'MZM', definitionId: 'library-mzm',
          parameterOverrides: { intrinsicLoss: fixed(0), vPi: fixed(5) } });
        connections.push({ id: 'supply', from: local(key, 'OPT_OUT'), to: local(emitter, 'LASER_IN') });
      }
      const branch = local('wdm', port.id);
      connections.push({ id: 'branch' + i, from: source ? local(emitter, 'OPT_OUT') : branch,
        to: source ? branch : local(key, 'OPT_IN') });
    }
    return { id, kind: 'module', name: '机箱 ' + id, ports: [{ id: 'COM', name: 'COM', direction: 'bidirectional', type: 'OPTICAL' }],
      instances, connections, portMappings: [{ portId: 'COM', target: local('wdm', 'COM') }] };
  }
  return { id: 'two-wdm', name: '双机箱 WDM', rootModuleDefinitionId: 'root', namedLinks,
    componentDefinitions: [wdm, reverse, ...['library-laser', 'library-pd', ...(modulated ? ['library-mzm', 'library-dml'] : [])].map(component)],
    moduleDefinitions: [root, box('A', wdm), box('B', reverse)],
    layout: {
      topology: ['A', 'B'].flatMap((box, i) => [
        { instancePath: [box], x: 80 + i * 870, y: 140 },
        { instancePath: [box, 'wdm'], x: 300, y: 160 },
        ...wdmChannels.map((_, index) => ({ instancePath: [box, 'wave' + index],
          x: (index < 2) === (box === 'A') ? 42 : 555, y: 110 + index % 2 * 155 })),
        ...(modulated && box === 'A' ? [{ instancePath: [box, 'mzm'], x: 300, y: 330 }] : []),
      ]),
      topologyFrames: ['A', 'B'].map(box => ({ modulePath: [box], x: 0, y: 0, width: 780, height: modulated ? 485 : 405 })),
    } };
}

import type { OpticalChannelId } from '../../../src/model/v1/channels';
import type { ComponentDefinition, ModuleDefinition, PortDefinition, Project } from '../../../src/model/v1/types';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const com: PortDefinition = { id: 'COM', name: 'COM', type: 'OPTICAL', direction: 'bidirectional', side: 'top' };
const local = (instanceId: string, portId: string) => ({ instanceId, portId });

export function duplexFixture(): Project {
  const channels = ['DWDM_CH28', 'DWDM_CH30'] as const;
  function router(id: string, send: OpticalChannelId, receive: OpticalChannelId): ComponentDefinition {
    return { kind: 'component', id, name: id, ports: [com,
      { id: 'TX', type: 'OPTICAL', direction: 'in', name: 'TX' }, { id: 'RX', type: 'OPTICAL', direction: 'out', name: 'RX' }],
    transfers: [
      { kind: 'optical', fromPortId: 'TX', toPortId: 'COM', channelIds: [send], gainDb: fixed(-1) },
      { kind: 'optical', fromPortId: 'COM', toPortId: 'RX', channelIds: [receive], gainDb: fixed(-2) },
    ] };
  }
  function box(id: string): ModuleDefinition {
    return { kind: 'module', id, name: id, ports: [com], instances: [
      { id: 'router', name: '路由器', definitionId: 'router-' + id },
      { id: 'laser', name: '光源', definitionId: 'laser' }, { id: 'pd', name: '接收端', definitionId: 'pd' }],
    portMappings: [{ portId: 'COM', target: local('router', 'COM') }],
    connections: [
      { id: 'send', from: local('laser', 'OUT'), to: local('router', 'TX') },
      { id: 'receive', from: local('router', 'RX'), to: local('pd', 'IN') },
    ] };
  }
  return { id: 'duplex', name: '双向光纤验收', rootModuleDefinitionId: 'root',
    componentDefinitions: [
      router('router-A', channels[0], channels[1]), router('router-B', channels[1], channels[0]),
      { kind: 'component', id: 'laser', name: '光源', ports: [
        { id: 'OUT', name: '光输出', type: 'OPTICAL', direction: 'out', opticalEmitter: { powerDbm: fixed(10) } }] },
      { kind: 'component', id: 'pd', name: '接收端', ports: [{ id: 'IN', name: '光输入', type: 'OPTICAL', direction: 'in' }] },
    ],
    moduleDefinitions: [{ kind: 'module', id: 'root', name: '系统', ports: [],
      instances: ['A', 'B'].map(id => ({ id, name: '模块 ' + id, definitionId: id })),
      cableBundles: [{ id: 'mpo', coreCount: 12, cores: [{ id: 'single',
        a: { pin: 1, endpoint: local('A', 'COM') }, b: { pin: 12, endpoint: local('B', 'COM') } }] }],
    }, box('A'), box('B')],
    namedLinks: channels.map((channelId, index) => ({ id: 'link' + index, name: index ? 'B → A' : 'A → B', channelId,
      from: { instancePath: [index ? 'B' : 'A', 'laser'], portId: 'OUT' },
      to: { instancePath: [index ? 'A' : 'B', 'pd'], portId: 'IN' }, via: [{ scopePath: [], bundleId: 'mpo', coreId: 'single' }] })),
  };
}

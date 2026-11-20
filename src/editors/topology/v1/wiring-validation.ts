import { channelSetsOverlap } from '../../../model/v1/validate-device';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import type { ModuleDefinition, PortDefinition } from '../../../model/v1/types';
import { portTypeLabels } from '../../../workbench/v1/labels';

export type CanvasPort = {
  port: PortDefinition;
  endpoint?: LocalEndpointRef;
  direction: PortDefinition['direction'];
};

function sameEndpoint(a?: LocalEndpointRef, b?: LocalEndpointRef): boolean {
  return a !== undefined && b !== undefined && a.instanceId === b.instanceId && a.portId === b.portId;
}

export function wiringProblem(module: ModuleDefinition, a?: CanvasPort, b?: CanvasPort): string | undefined {
  if (!a || !b || a === b) return '请选择两个不同的端口。';
  if (!a.endpoint && !b.endpoint) return '对外端口应连接到模块内的器件或子模块。';
  if (a.direction === b.direction) return `两个端口都是${a.direction === 'out' ? '输出' : '输入'}，请连接一个输出和一个输入。`;
  if (a.port.type !== b.port.type) {
    return `端口类型不匹配：${portTypeLabels[a.port.type]}不能连接${portTypeLabels[b.port.type]}。`;
  }
  if (!channelSetsOverlap(a.port, b.port)) return '两个光端口没有共同的光通道。';
  const [source, target] = a.direction === 'out' ? [a, b] : [b, a];
  if (source.endpoint && target.endpoint) {
    const connected = module.connections?.some(item => sameEndpoint(item.from, source.endpoint) && sameEndpoint(item.to, target.endpoint))
      || module.cableBundles?.some(bundle => bundle.cores.some(core =>
        (sameEndpoint(core.a.endpoint, source.endpoint) && sameEndpoint(core.b.endpoint, target.endpoint))
        || (sameEndpoint(core.b.endpoint, source.endpoint) && sameEndpoint(core.a.endpoint, target.endpoint))));
    if (connected) return '这两个端口已连接。';
  } else {
    const outer = a.endpoint ? b : a;
    if (module.portMappings?.some(item => item.portId === outer.port.id && sameEndpoint(item.target, a.endpoint ?? b.endpoint))) {
      return '这个对外端口已接到所选端口。';
    }
  }
}

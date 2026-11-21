import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, InstancePath } from '../../model/v1/types';

export function remapLinkReferences(link: NamedLink, path: (path: InstancePath) => InstancePath,
  endpoint: (endpoint: EndpointRef) => EndpointRef,
  required: (ref: NonNullable<NamedLink['via']>[number]) => NonNullable<NamedLink['via']>[number]): NamedLink {
  return {
    ...link, from: link.from && endpoint(link.from), to: link.to && endpoint(link.to),
    via: link.via?.map(required),
    conversionBindings: link.conversionBindings?.map(binding => ({
      ...binding,
      eo: { ...binding.eo, instancePath: path(binding.eo.instancePath) },
      oe: { ...binding.oe, instancePath: path(binding.oe.instancePath) },
    })),
    ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.map(source => ({
      ...source, endpoint: endpoint(source.endpoint),
    })) } }),
  };
}

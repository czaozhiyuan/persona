import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, InstancePath } from '../../model/v1/types';

export function remapLinkReferences(link: NamedLink, path: (path: InstancePath) => InstancePath,
  endpoint: (endpoint: EndpointRef) => EndpointRef,
  required: (ref: NonNullable<NamedLink['via']>[number]) => NonNullable<NamedLink['via']>[number] | undefined): NamedLink {
  return {
    ...link, from: link.from && endpoint(link.from), to: link.to && endpoint(link.to),
    via: link.via?.flatMap(ref => {
      const next = required(ref);
      return next ? [next] : [];
    }),
    ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.map(source => ({
      ...source, endpoint: endpoint(source.endpoint),
    })) } }),
  };
}

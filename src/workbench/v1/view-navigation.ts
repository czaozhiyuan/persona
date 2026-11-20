import type { ProjectStore, ProjectStoreSnapshot } from '../../state/v1/project-store';

export type TopologyLocation = Pick<ProjectStoreSnapshot['selection'], 'modulePath' | 'instancePath'>;

export function returnToTopology(store: ProjectStore, previous: TopologyLocation | undefined) {
  const { modulePath, instancePath, view } = store.getSnapshot().selection;
  if (view === 'physical' && instancePath
    && JSON.stringify([modulePath, instancePath]) !== JSON.stringify([previous?.modulePath, previous?.instancePath])) {
    store.selectModule(instancePath.slice(0, -1));
    store.selectInstance(instancePath);
  }
  store.setView('topology');
}

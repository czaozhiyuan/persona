import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, Project } from '../../model/v1/types';
import { validateProjectSnapshot } from '../../storage/v1/project-json';

type View = 'topology' | 'physical';

type Selection = Readonly<{
  view: View;
  modulePath: InstancePath;
  instancePath?: InstancePath;
  linkId?: string;
}>;

export type ProjectStoreSnapshot = Readonly<{
  project: Project;
  selection: Selection;
  canUndo: boolean;
  canRedo: boolean;
}>;

type EditResult = { ok: true } | { ok: false; message: string };
type Listener = () => void;

function freezeData<T>(data: T): T {
  if (data !== null && typeof data === 'object' && !Object.isFrozen(data)) {
    Object.values(data).forEach(freezeData);
    Object.freeze(data);
  }
  return data;
}

function prepareProject(project: Project): Project {
  validateProjectSnapshot(project);
  return freezeData(structuredClone(project));
}

function samePath(a: InstancePath, b: InstancePath): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

const initialSelection: Selection = freezeData({ view: 'topology', modulePath: [] });

export function createProjectStore(initialProject: Project) {
  const undoStack: Project[] = [];
  const redoStack: Project[] = [];
  const listeners = new Set<Listener>();
  let snapshot: ProjectStoreSnapshot = Object.freeze({
    project: prepareProject(initialProject), selection: initialSelection, canUndo: false, canRedo: false,
  });
  let hierarchy = resolveHierarchy(snapshot.project);

  function publish(project: Project, selection: Selection) {
    snapshot = Object.freeze({
      project, selection: freezeData(selection), canUndo: undoStack.length > 0, canRedo: redoStack.length > 0,
    });
    for (const listener of listeners) listener();
  }

  function reconcile(project: Project): Selection {
    const selection = snapshot.selection;
    let { modulePath, instancePath, linkId } = selection;
    while (hierarchy.resolveInstance(modulePath)?.definition.kind !== 'module') modulePath = modulePath.slice(0, -1);
    if (instancePath && !hierarchy.resolveInstance(instancePath)?.instance) instancePath = undefined;
    if (linkId !== undefined && !project.namedLinks?.some(link => link.id === linkId)) linkId = undefined;
    return { ...selection, modulePath, instancePath, linkId };
  }

  function changeProject(project: Project, resetSelection = false) {
    hierarchy = resolveHierarchy(project);
    publish(project, resetSelection ? initialSelection : reconcile(project));
  }

  function commit(edit: (draft: Project) => Project): EditResult {
    let project: Project;
    try {
      project = prepareProject(edit(structuredClone(snapshot.project)));
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    undoStack.push(snapshot.project);
    redoStack.length = 0;
    changeProject(project);
    return { ok: true };
  }

  function replaceProject(candidate: Project): EditResult {
    let project: Project;
    try {
      project = prepareProject(candidate);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    undoStack.length = 0;
    redoStack.length = 0;
    changeProject(project, true);
    return { ok: true };
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(snapshot.project);
    changeProject(previous);
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snapshot.project);
    changeProject(next);
  }

  function setView(view: View) {
    if (snapshot.selection.view !== view) publish(snapshot.project, { ...snapshot.selection, view });
  }

  function selectModule(path: InstancePath) {
    if (hierarchy.resolveInstance(path)?.definition.kind !== 'module' || samePath(path, snapshot.selection.modulePath)) return;
    publish(snapshot.project, { ...snapshot.selection, modulePath: [...path], instancePath: undefined });
  }

  function selectInstance(path?: InstancePath) {
    if (path && !hierarchy.resolveInstance(path)?.instance) return;
    publish(snapshot.project, { ...snapshot.selection, instancePath: path && [...path] });
  }

  function selectLink(linkId?: string) {
    if (linkId !== undefined && !snapshot.project.namedLinks?.some(link => link.id === linkId)) return;
    publish(snapshot.project, { ...snapshot.selection, linkId });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    commit, replaceProject, undo, redo, setView, selectModule, selectInstance, selectLink,
    resolveInstance: (path: InstancePath) => hierarchy.resolveInstance(path),
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

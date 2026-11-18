import type { Project } from '../../model/v1/types';
import { validateProject } from '../../model/v1/validate';
import { assertProjectShape, ProjectStructureError } from './project-schema';
export { ProjectStructureError } from './project-schema';

export const PROJECT_FILE_FORMAT = 'persona-project';
export const PROJECT_SCHEMA_VERSION = 1;

export class ProjectFileError extends Error {
  constructor(readonly stage: 'syntax' | 'format' | 'domain', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectFileError';
  }
}

/** Checks an in-memory snapshot without changing it. */
export function validateProjectSnapshot(value: unknown): asserts value is Project {
  assertProjectShape(value);
  try {
    validateProject(value);
  } catch (error) {
    throw new ProjectFileError('domain', `$.project: ${(error as Error).message}`, { cause: error });
  }
}

/** Returns a new snapshot only after the whole file passes validation. */
export function parseProjectJson(source: string): Project {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ProjectFileError('syntax', `Invalid project JSON: ${(error as Error).message}`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectFileError('format', '$: expected a Persona project file object');
  }
  const file = value as Record<string, unknown>;
  if (!Object.hasOwn(file, 'format') || file.format !== PROJECT_FILE_FORMAT) {
    throw new ProjectFileError('format', `$.format: expected "${PROJECT_FILE_FORMAT}"`);
  }
  if (!Object.hasOwn(file, 'schemaVersion') || file.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectFileError('format', `$.schemaVersion: only version ${PROJECT_SCHEMA_VERSION} is supported`);
  }
  for (const key of Object.keys(file)) {
    if (!['format', 'schemaVersion', 'project'].includes(key)) {
      throw new ProjectStructureError(`$[${JSON.stringify(key)}]`, 'unknown field');
    }
  }
  const project = Object.hasOwn(file, 'project') ? file.project : undefined;
  validateProjectSnapshot(project);
  return project;
}

/** Applies the same shape and domain rules as import before producing file content. */
export function serializeProjectJson(project: Project): string {
  validateProjectSnapshot(project);
  const file = { format: PROJECT_FILE_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, project };
  return JSON.stringify(file, null, 2) + '\n';
}

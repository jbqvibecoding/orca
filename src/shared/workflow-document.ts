// A workflow document declares the phases a task walks through: what to tell
// the worker, which file proves the phase is done, and which acceptance checks
// must pass before the next phase starts.
//
// YAML rather than TOML: Orca already ships `yaml` and already reads a bounded
// repo-level config with it (`orca-yaml.ts`), while its only TOML code is a
// byte-preserving line scanner for Codex's config.toml that cannot produce a
// document. Reusing the YAML bounds also inherits their alias/size protection.

import { parseDocument } from 'yaml'
import { isAcceptanceCheckName, type AcceptanceCheckName } from './acceptance-gate'
import {
  isOrcaYamlFieldWithinLimit,
  isOrcaYamlTextWithinLimit,
  MAX_ORCA_YAML_ALIAS_COUNT,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'
import {
  isWorkflowPhaseId,
  resolveWorkflowPhaseGate,
  WORKFLOW_PHASES,
  type WorkflowPhaseGate,
  type WorkflowPhaseId
} from './workflow-phase'

export const WORKFLOW_DOCUMENT_FILE_EXTENSION = '.yaml'
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const WORKFLOW_NAME_RULE =
  'Use 1-64 lowercase letters, numbers, or hyphens, starting with a letter or number.'

export type WorkflowPhaseDocument = {
  instruction: string | null
  /** Workspace-relative path whose existence completes the phase; one `*` segment allowed. */
  artifact: string | null
  accepts: readonly AcceptanceCheckName[]
  gate: WorkflowPhaseGate
}

export type WorkflowDocument = {
  name: string
  description: string | null
  /**
   * Phase the last one returns to, incrementing the cycle counter; null means
   * the workflow ends there. A named target rather than a `cyclic: true` flag
   * because "loop back" alone does not say where — agtx's review loop returns
   * to planning, not to the read-only research phase ahead of it.
   */
  cycleTo: WorkflowPhaseId | null
  phases: Readonly<Partial<Record<WorkflowPhaseId, WorkflowPhaseDocument>>>
  /** Top-level keys this build does not handle, so a UI can suggest an update. */
  unknownKeys: readonly string[]
}

export type WorkflowDocumentParse =
  | { ok: true; document: WorkflowDocument }
  | { ok: false; error: string }

const RECOGNIZED_KEYS = new Set(['name', 'description', 'cycle_to', 'phases'])
const RECOGNIZED_PHASE_KEYS = new Set(['instruction', 'artifact', 'accepts'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asBoundedString(value: unknown): string | null {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Artifact patterns come from a user-authored document and are joined onto a
 * workspace root, so traversal is rejected here rather than at read time:
 * `joinWorktreeRelativePath` joins without validating.
 *
 * One whole-segment `*` is the entire glob surface. `foo*.md` is rejected so
 * matching stays a directory listing plus an equality test, with no glob
 * engine and no path where a pattern can walk a tree.
 */
export function isValidWorkflowArtifactPattern(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return false
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false
  }
  if (segments.filter((segment) => segment === '*').length > 1) {
    return false
  }
  return !segments.some((segment) => segment !== '*' && segment.includes('*'))
}

function parseAccepts(value: unknown, phase: string): AcceptanceCheckName[] | string {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return `phase "${phase}": accepts must be a list of check names.`
  }
  const checks: AcceptanceCheckName[] = []
  for (const entry of value) {
    if (!isAcceptanceCheckName(entry)) {
      // Why name the allowlist: it is the point of the acceptance contract, not
      // an arbitrary spelling rule — a workflow cannot invent a new check.
      return `phase "${phase}": "${String(entry)}" is not an acceptance check. Use typecheck, test, or lint.`
    }
    if (!checks.includes(entry)) {
      checks.push(entry)
    }
  }
  return checks
}

type ParsedPhase = Omit<WorkflowPhaseDocument, 'gate'>

function parsePhase(
  phase: WorkflowPhaseId,
  raw: unknown
): { phase: ParsedPhase; unknown: string[] } | string {
  const record = asRecord(raw)
  if (!record) {
    return `phase "${phase}" must be a mapping.`
  }
  const instruction = typeof record.instruction === 'string' ? record.instruction : null
  if (instruction !== null && !isOrcaYamlFieldWithinLimit(instruction)) {
    return `phase "${phase}": instruction is too large.`
  }
  const artifact = asBoundedString(record.artifact)
  if (artifact !== null && !isValidWorkflowArtifactPattern(artifact)) {
    return `phase "${phase}": artifact "${artifact}" must be a workspace-relative path with at most one \`*\` segment.`
  }
  if (artifact !== null && artifact.includes('{task}')) {
    return `phase "${phase}": artifact cannot contain {task}; use {task_id} or {phase}.`
  }
  const accepts = parseAccepts(record.accepts, phase)
  if (typeof accepts === 'string') {
    return accepts
  }
  return {
    phase: {
      instruction: instruction !== null && instruction.trim().length > 0 ? instruction : null,
      artifact,
      accepts
    },
    unknown: Object.keys(record).filter((key) => !RECOGNIZED_PHASE_KEYS.has(key))
  }
}

function parseYamlRoot(content: string): Record<string, unknown> | string {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return 'Workflow document is too large.'
  }
  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0) {
      return `Workflow document is not valid YAML: ${document.errors[0].message}`
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch (error) {
    return `Workflow document is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
  }
  const record = asRecord(root)
  return record ?? 'Workflow document must be a mapping at the top level.'
}

export function parseWorkflowDocument(content: string): WorkflowDocumentParse {
  const record = parseYamlRoot(content)
  if (typeof record === 'string') {
    return { ok: false, error: record }
  }

  const name = asBoundedString(record.name)
  if (name === null || !WORKFLOW_NAME_PATTERN.test(name)) {
    return { ok: false, error: `Workflow needs a name. ${WORKFLOW_NAME_RULE}` }
  }

  const phasesRecord = asRecord(record.phases)
  if (!phasesRecord) {
    return { ok: false, error: `Workflow "${name}" needs a phases mapping.` }
  }

  const unknownKeys = Object.keys(record).filter((key) => !RECOGNIZED_KEYS.has(key))
  const parsedPhases: Partial<Record<WorkflowPhaseId, ParsedPhase>> = {}
  for (const [key, raw] of Object.entries(phasesRecord)) {
    if (!isWorkflowPhaseId(key)) {
      return {
        ok: false,
        error: `Workflow "${name}": "${key}" is not a phase. Use ${WORKFLOW_PHASES.join(', ')}.`
      }
    }
    const parsed = parsePhase(key, raw)
    if (typeof parsed === 'string') {
      return { ok: false, error: `Workflow "${name}": ${parsed}` }
    }
    parsedPhases[key] = parsed.phase
    unknownKeys.push(...parsed.unknown.map((entry) => `phases.${key}.${entry}`))
  }

  // Why a second pass: a phase's gate depends on the phase this document
  // declares before it, which is not known until every phase is parsed. A
  // workflow that declares only planning and review gates review on planning.
  const declared = WORKFLOW_PHASES.filter((phase) => parsedPhases[phase] !== undefined)
  if (declared.length === 0) {
    return { ok: false, error: `Workflow "${name}" declares no phases.` }
  }
  const phases: Partial<Record<WorkflowPhaseId, WorkflowPhaseDocument>> = {}
  declared.forEach((phase, index) => {
    const before = index === 0 ? null : declared[index - 1]
    phases[phase] = {
      ...(parsedPhases[phase] as ParsedPhase),
      gate: resolveWorkflowPhaseGate(
        before === null ? null : { phase: before, artifact: parsedPhases[before]?.artifact ?? null }
      )
    }
  })

  const cycleTo = record.cycle_to
  if (cycleTo !== undefined && (!isWorkflowPhaseId(cycleTo) || phases[cycleTo] === undefined)) {
    return {
      ok: false,
      error: `Workflow "${name}": cycle_to must name a phase this workflow declares.`
    }
  }

  return {
    ok: true,
    document: {
      name,
      description: asBoundedString(record.description),
      cycleTo: cycleTo === undefined ? null : cycleTo,
      phases,
      unknownKeys
    }
  }
}

/** The phases this document declares, in canonical order. */
export function orderedWorkflowPhases(document: WorkflowDocument): WorkflowPhaseId[] {
  return WORKFLOW_PHASES.filter((phase) => document.phases[phase] !== undefined)
}

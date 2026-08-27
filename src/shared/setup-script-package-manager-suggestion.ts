import type {
  SetupScriptImportCandidate,
  SetupScriptImportFileExists,
  SetupScriptImportFileRead
} from './setup-script-imports'
import { isSetupScriptImportFieldWithinLimit } from './setup-script-import-limits'
import {
  DEFAULT_PACKAGE_MANAGER,
  PACKAGE_MANAGER_LOCKFILES,
  buildPackageManagerInstallCommand,
  parsePackageManagerField,
  selectPackageManagerLockfile
} from './package-manager-detection'

const PACKAGE_JSON_PATH = 'package.json'

export async function inspectPackageManagerSetupCandidate(
  readFile: SetupScriptImportFileRead,
  fileExists?: SetupScriptImportFileExists
): Promise<SetupScriptImportCandidate | null> {
  const packageJsonContent = await readFile(PACKAGE_JSON_PATH)
  const packageJson = parsePackageJson(packageJsonContent)
  if (!packageJson) {
    return null
  }

  const packageManager = getPackageManagerName(packageJson.packageManager)
  const packageManagerSetup = packageManager
    ? buildPackageManagerInstallCommand(packageManager)
    : null
  if (packageManagerSetup) {
    return {
      provider: 'package-manager',
      label: 'package manager',
      files: [PACKAGE_JSON_PATH],
      setup: packageManagerSetup,
      unsupportedFields: []
    }
  }

  const checkFileExists = fileExists ?? fallbackFileExists(readFile)
  const lockfileReads = await Promise.all(
    PACKAGE_MANAGER_LOCKFILES.map(async (entry) => ({
      path: entry.path,
      exists: await checkFileExists(entry.path)
    }))
  )
  const selection = selectPackageManagerLockfile(
    lockfileReads.filter((entry) => entry.exists).map((entry) => entry.path)
  )
  if (!selection.ok) {
    return null
  }
  const selectedLockfile = selection.lockfile
  const setup = buildPackageManagerInstallCommand(
    selectedLockfile?.manager ?? DEFAULT_PACKAGE_MANAGER
  )

  return {
    provider: 'package-manager',
    label: 'package manager',
    files: selectedLockfile ? [selectedLockfile.path] : [PACKAGE_JSON_PATH],
    setup,
    unsupportedFields: []
  }
}

function fallbackFileExists(readFile: SetupScriptImportFileRead): SetupScriptImportFileExists {
  return async (relativePath) => (await readFile(relativePath)) !== null
}

function parsePackageJson(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const parsed = JSON.parse(content)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function getPackageManagerName(value: unknown) {
  if (typeof value !== 'string' || !isSetupScriptImportFieldWithinLimit(value)) {
    return null
  }
  return parsePackageManagerField(value)
}

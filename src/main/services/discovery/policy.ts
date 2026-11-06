import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ItemKind } from '../../../shared/types/domain'
import type { DiscoverySkipReason } from './types'

export const DEFAULT_PHOTO_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.bmp',
  '.gif',
  '.avif',
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.orf',
  '.rw2',
  '.raf',
  '.pef'
]

export const DEFAULT_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.rtf',
  '.doc',
  '.docx',
  '.odt',
  '.xls',
  '.xlsx',
  '.ods',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.odp',
  '.epub'
]

export const DEFAULT_SOFTWARE_CLUTTER_DIRECTORY_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'bower_components',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.ruff_cache',
  'target',
  'build',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  '.gradle',
  '.idea',
  '.vscode',
  'obj',
  'bin',
  'cmakefiles'
]

export const DEFAULT_HIDDEN_AND_SYSTEM_NAMES: readonly string[] = [
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '@eadir',
  '__macosx',
  '$recycle.bin',
  'system volume information',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd'
]

/**
 * Known software/repository boilerplate filenames that should be filtered out as
 * software clutter even when they use `.txt` or `.md` extensions. Valuable user and
 * project documentation (such as `README.md`, design notes, instructions, and lists)
 * remains included.
 */
export const DEFAULT_SOFTWARE_CLUTTER_FILE_NAMES: readonly string[] = [
  'cmakelists.txt',
  'requirements.txt',
  'requirements-dev.txt',
  'constraints.txt',
  'runtime.txt',
  'robots.txt',
  'llms.txt',
  'changelog.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'pull_request_template.md',
  'issue_template.md',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock'
]

export interface DiscoveryPolicyConfig {
  readonly photoExtensions?: readonly string[]
  readonly documentExtensions?: readonly string[]
  readonly excludedPaths?: readonly string[]
  readonly excludedDirectoryNames?: readonly string[]
  readonly softwareClutterDirectoryNames?: readonly string[]
  readonly softwareClutterFileNames?: readonly string[]
  readonly hiddenAndSystemNames?: readonly string[]
  readonly excludeHiddenEntries?: boolean
}

export interface ResolvedDiscoveryPolicy {
  readonly photoExtensions: ReadonlySet<string>
  readonly documentExtensions: ReadonlySet<string>
  readonly excludedPaths: ReadonlySet<string>
  readonly excludedDirectoryNames: ReadonlySet<string>
  readonly softwareClutterDirectoryNames: ReadonlySet<string>
  readonly softwareClutterFileNames: ReadonlySet<string>
  readonly hiddenAndSystemNames: ReadonlySet<string>
  readonly excludeHiddenEntries: boolean
}

export function normalizePathForComparison(targetPath: string): string {
  const resolved = resolve(targetPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

export function resolveDiscoveryPolicy(
  config: DiscoveryPolicyConfig = {}
): ResolvedDiscoveryPolicy {
  const photoExtensions = new Set(
    (config.photoExtensions ?? DEFAULT_PHOTO_EXTENSIONS).map(normalizeExtension)
  )
  const documentExtensions = new Set(
    (config.documentExtensions ?? DEFAULT_DOCUMENT_EXTENSIONS).map(normalizeExtension)
  )
  const excludedPaths = new Set(
    (config.excludedPaths ?? []).map((p) => normalizePathForComparison(p))
  )
  const excludedDirectoryNames = new Set(
    (config.excludedDirectoryNames ?? []).map((name) => name.trim().toLowerCase())
  )
  const softwareClutterDirectoryNames = new Set(
    (config.softwareClutterDirectoryNames ?? DEFAULT_SOFTWARE_CLUTTER_DIRECTORY_NAMES).map((name) =>
      name.trim().toLowerCase()
    )
  )
  const softwareClutterFileNames = new Set(
    (config.softwareClutterFileNames ?? DEFAULT_SOFTWARE_CLUTTER_FILE_NAMES).map((name) =>
      name.trim().toLowerCase()
    )
  )
  const hiddenAndSystemNames = new Set(
    (config.hiddenAndSystemNames ?? DEFAULT_HIDDEN_AND_SYSTEM_NAMES).map((name) =>
      name.trim().toLowerCase()
    )
  )

  return {
    photoExtensions,
    documentExtensions,
    excludedPaths,
    excludedDirectoryNames,
    softwareClutterDirectoryNames,
    softwareClutterFileNames,
    hiddenAndSystemNames,
    excludeHiddenEntries: config.excludeHiddenEntries ?? true
  }
}

export type DirectoryDecision =
  | { readonly action: 'traverse' }
  | { readonly action: 'skip'; readonly reason: DiscoverySkipReason; readonly detail: string }

/**
 * Checks whether `targetPath` matches an entry in `excludedPaths` or is nested
 * inside an excluded ancestor path.
 */
export function isPathOrAncestorExcluded(
  targetPath: string,
  excludedPaths: ReadonlySet<string>
): string | null {
  if (excludedPaths.size === 0) {
    return null
  }
  const normalizedTarget = normalizePathForComparison(targetPath)
  if (excludedPaths.has(normalizedTarget)) {
    return normalizedTarget
  }
  for (const excludedPath of excludedPaths) {
    const rel = relative(excludedPath, normalizedTarget)
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return excludedPath
    }
  }
  return null
}

/**
 * Evaluates a directory against the discovery exclusion policy.
 *
 * Precedence order (for both explicitly supplied source roots and nested directories):
 * 1. Explicit path exclusions (`excludedPaths`, matching the directory itself or any
 *    ancestor directory) -> `excluded_directory`
 * 2. Explicit directory name exclusions (`excludedDirectoryNames` on `dirName`)
 *    -> `excluded_directory`
 * 3. Software/build clutter directory names (`softwareClutterDirectoryNames` on `dirName`)
 *    -> `software_clutter_directory`
 * 4. Hidden/system directory names (`hiddenAndSystemNames` or dot-prefixed `dirName`
 *    when `excludeHiddenEntries` is enabled) -> `hidden_or_system_entry`
 *
 * Note on source roots: name-based rules (2-4) are evaluated against the root's own
 * basename (`dirName`), never against ancestor path segments above an explicitly
 * supplied root.
 */
export function evaluateDirectoryEntry(
  dirPath: string,
  dirName: string,
  policy: ResolvedDiscoveryPolicy
): DirectoryDecision {
  const lowerName = dirName.toLowerCase()
  const matchedExcludedPath = isPathOrAncestorExcluded(dirPath, policy.excludedPaths)

  if (matchedExcludedPath !== null) {
    const normalizedPath = normalizePathForComparison(dirPath)
    return {
      action: 'skip',
      reason: 'excluded_directory',
      detail:
        matchedExcludedPath === normalizedPath
          ? 'Directory path is in the configured exclusion list'
          : `Directory path is nested under excluded ancestor "${matchedExcludedPath}"`
    }
  }

  if (policy.excludedDirectoryNames.has(lowerName)) {
    return {
      action: 'skip',
      reason: 'excluded_directory',
      detail: `Directory name "${dirName}" is in the configured exclusion list`
    }
  }

  if (policy.softwareClutterDirectoryNames.has(lowerName)) {
    return {
      action: 'skip',
      reason: 'software_clutter_directory',
      detail: `Directory "${dirName}" matches software/build clutter rule`
    }
  }

  if (
    policy.hiddenAndSystemNames.has(lowerName) ||
    (policy.excludeHiddenEntries && dirName.startsWith('.'))
  ) {
    return {
      action: 'skip',
      reason: 'hidden_or_system_entry',
      detail: `Directory "${dirName}" is a hidden or system metadata directory`
    }
  }

  return { action: 'traverse' }
}

export type FileDecision =
  | {
      readonly action: 'include'
      readonly candidateKind: ItemKind
      readonly extension: string
    }
  | {
      readonly action: 'skip'
      readonly reason: DiscoverySkipReason
      readonly detail: string
    }

export function evaluateFileEntry(fileName: string, policy: ResolvedDiscoveryPolicy): FileDecision {
  const lowerName = fileName.toLowerCase()

  if (
    policy.hiddenAndSystemNames.has(lowerName) ||
    (policy.excludeHiddenEntries && fileName.startsWith('.'))
  ) {
    return {
      action: 'skip',
      reason: 'hidden_or_system_entry',
      detail: `File "${fileName}" is a hidden or OS metadata entry`
    }
  }

  if (policy.softwareClutterFileNames.has(lowerName)) {
    return {
      action: 'skip',
      reason: 'software_clutter_file',
      detail: `File "${fileName}" matches software clutter filename rule`
    }
  }

  const extension = extname(fileName).toLowerCase()
  if (!extension) {
    return {
      action: 'skip',
      reason: 'unsupported_extension',
      detail: `File "${fileName}" has no file extension`
    }
  }

  if (policy.photoExtensions.has(extension)) {
    return {
      action: 'include',
      candidateKind: 'photo',
      extension
    }
  }

  if (policy.documentExtensions.has(extension)) {
    return {
      action: 'include',
      candidateKind: 'document',
      extension
    }
  }

  return {
    action: 'skip',
    reason: 'unsupported_extension',
    detail: `Extension "${extension}" is not in the candidate photo or document policy`
  }
}

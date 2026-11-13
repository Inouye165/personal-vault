import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export interface ResolveMainWorkerOptions {
  readonly workerFileName: string
  readonly sourceEntryPath: string
  readonly customPath?: string
  readonly moduleDir?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly isTest?: boolean
  readonly cwd?: string
  readonly esbuildExternals?: readonly string[]
}

interface ElectronAppInfo {
  readonly isPackaged: boolean
  readonly appPath: string
}

const cachedTestWorkerPaths = new Map<string, string>()

function tryGetElectronAppInfo(): ElectronAppInfo | null {
  if (!process.versions.electron) {
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: { isPackaged?: boolean; getAppPath?: () => string }
    }
    if (electron?.app && typeof electron.app.getAppPath === 'function') {
      return {
        isPackaged: Boolean(electron.app.isPackaged),
        appPath: electron.app.getAppPath()
      }
    }
  } catch {
    // Ignore when running outside Electron main process
  }
  return null
}

/**
 * Resolves a compiled main-process worker script path deterministically.
 *
 * In packaged Electron runs, resolution is strictly anchored to the application
 * installation (`app.getAppPath()` and module-relative `out/main` paths, including
 * Rollup `chunks/` parent traversal) and fails closed without consulting `process.cwd()`,
 * invoking `esbuild`, or writing into the launch directory.
 */
export function resolveMainWorkerScriptPath(options: ResolveMainWorkerOptions): string {
  const {
    workerFileName,
    sourceEntryPath,
    customPath,
    moduleDir = __dirname,
    esbuildExternals = ['sharp', 'electron', 'onnxruntime-node']
  } = options

  const electronInfo =
    options.appPath !== undefined || options.isPackaged !== undefined
      ? null
      : tryGetElectronAppInfo()

  const isPackaged = options.isPackaged ?? electronInfo?.isPackaged ?? false
  const appPath = options.appPath !== undefined ? options.appPath : (electronInfo?.appPath ?? null)
  const isTest =
    options.isTest ?? (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')

  if (customPath) {
    if (existsSync(customPath)) {
      return customPath
    }
    if (isPackaged) {
      throw new Error(`Packaged worker script not found at custom path: ${customPath}`)
    }
  }

  const appInstallCandidates: string[] = []
  if (appPath) {
    appInstallCandidates.push(join(appPath, 'out', 'main', workerFileName))
  }
  // Support both direct out/main/*.js and Rollup-split out/main/chunks/*.js
  appInstallCandidates.push(join(moduleDir, workerFileName))
  appInstallCandidates.push(join(moduleDir, '..', workerFileName))

  if (isPackaged) {
    for (const candidate of appInstallCandidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    throw new Error(
      `Packaged worker script not found (${workerFileName}). Checked: ${appInstallCandidates.join(', ')}`
    )
  }

  if (!isTest) {
    for (const candidate of appInstallCandidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }

  const cacheKey = `${workerFileName}:${sourceEntryPath}`
  const cached = cachedTestWorkerPaths.get(cacheKey)
  if (cached && existsSync(cached)) {
    return cached
  }

  const cwd = options.cwd ?? process.cwd()
  const outMainDir = join(cwd, 'out', 'main')
  if (!isTest) {
    const projectBuilt = resolve(outMainDir, workerFileName)
    if (existsSync(projectBuilt)) {
      cachedTestWorkerPaths.set(cacheKey, projectBuilt)
      return projectBuilt
    }
  }

  const baseName = basename(workerFileName, '.js')
  const tempWorker = isTest
    ? join(outMainDir, `${baseName}.vitest.${process.pid}.cjs`)
    : join(outMainDir, workerFileName)

  try {
    mkdirSync(outMainDir, { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild')
    esbuild.buildSync({
      entryPoints: [sourceEntryPath],
      outfile: tempWorker,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      external: [...esbuildExternals]
    })
    cachedTestWorkerPaths.set(cacheKey, tempWorker)
    if (isTest) {
      process.once('exit', () => {
        try {
          rmSync(tempWorker, { force: true })
        } catch {
          // ignore
        }
      })
    }
    return tempWorker
  } catch (err) {
    if (isTest) {
      return resolve(outMainDir, workerFileName)
    }
    throw err
  }
}

import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMainWorkerScriptPath } from '../../src/main/services/worker-path'
import { resolveSearchWorkerScriptPath } from '../../src/main/services/semantic/search-coordinator'
import { resolveWorkerScriptPath } from '../../src/main/services/thumbnails/coordinator'

describe('Packaged worker path resolution', () => {
  const tempDirs: string[] = []

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves worker from appPath independently of process.cwd() and Rollup chunks/ placement in packaged mode', () => {
    const appDir = makeTempDir('pv-app-asar-')
    const launchCwd = makeTempDir('pv-launch-cwd-')

    const outMainDir = join(appDir, 'out', 'main')
    const chunksDir = join(outMainDir, 'chunks')
    mkdirSync(chunksDir, { recursive: true })

    const packagedWorker = join(outMainDir, 'thumbnail_worker.js')
    writeFileSync(packagedWorker, '// packaged worker')

    const resolved = resolveMainWorkerScriptPath({
      workerFileName: 'thumbnail_worker.js',
      sourceEntryPath: join(appDir, 'src', 'main', 'services', 'thumbnails', 'worker.ts'),
      moduleDir: chunksDir,
      appPath: appDir,
      isPackaged: true,
      isTest: false,
      cwd: launchCwd
    })

    expect(resolved).toBe(packagedWorker)
    expect(existsSync(join(launchCwd, 'out'))).toBe(false)
  })

  it('fails closed in packaged mode when packaged worker is missing, even if cwd has out/main/thumbnail_worker.js', () => {
    const appDir = makeTempDir('pv-app-missing-')
    const launchCwd = makeTempDir('pv-repo-cwd-')

    const repoOutMain = join(launchCwd, 'out', 'main')
    mkdirSync(repoOutMain, { recursive: true })
    writeFileSync(join(repoOutMain, 'thumbnail_worker.js'), '// repo worker should never be used')

    const emptyLaunchCwd = makeTempDir('pv-empty-cwd-')

    expect(() =>
      resolveMainWorkerScriptPath({
        workerFileName: 'thumbnail_worker.js',
        sourceEntryPath: join(appDir, 'src', 'main', 'services', 'thumbnails', 'worker.ts'),
        moduleDir: join(appDir, 'out', 'main', 'chunks'),
        appPath: appDir,
        isPackaged: true,
        isTest: false,
        cwd: launchCwd
      })
    ).toThrow(/thumbnail_worker\.js/)

    expect(() =>
      resolveMainWorkerScriptPath({
        workerFileName: 'search_worker.js',
        sourceEntryPath: join(appDir, 'src', 'main', 'services', 'semantic', 'search-worker.ts'),
        moduleDir: join(appDir, 'out', 'main', 'chunks'),
        appPath: appDir,
        isPackaged: true,
        isTest: false,
        cwd: emptyLaunchCwd
      })
    ).toThrow(/search_worker\.js/)

    expect(existsSync(join(emptyLaunchCwd, 'out'))).toBe(false)
  })

  it('resolves worker from parent out/main when moduleDir is out/main/chunks in non-packaged built mode', () => {
    const appDir = makeTempDir('pv-built-')
    const launchCwd = makeTempDir('pv-unrelated-cwd-')
    const outMainDir = join(appDir, 'out', 'main')
    const chunksDir = join(outMainDir, 'chunks')
    mkdirSync(chunksDir, { recursive: true })

    const builtWorker = join(outMainDir, 'thumbnail_worker.js')
    writeFileSync(builtWorker, '// built worker')

    const resolved = resolveMainWorkerScriptPath({
      workerFileName: 'thumbnail_worker.js',
      sourceEntryPath: join(appDir, 'src', 'main', 'services', 'thumbnails', 'worker.ts'),
      moduleDir: chunksDir,
      appPath: null,
      isPackaged: false,
      isTest: false,
      cwd: launchCwd
    })

    expect(resolved).toBe(builtWorker)
    expect(existsSync(join(launchCwd, 'out'))).toBe(false)
  })

  it('exposes resolveWorkerScriptPath and resolveSearchWorkerScriptPath with customPath support', () => {
    const customDir = makeTempDir('pv-custom-worker-')
    const customThumb = join(customDir, 'custom-thumb.js')
    const customSearch = join(customDir, 'custom-search.js')
    writeFileSync(customThumb, '// custom thumb')
    writeFileSync(customSearch, '// custom search')

    expect(resolveWorkerScriptPath(customThumb)).toBe(customThumb)
    expect(resolveSearchWorkerScriptPath(customSearch)).toBe(customSearch)
  })
})

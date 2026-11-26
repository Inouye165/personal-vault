#!/usr/bin/env node
/**
 * Builds an isolated PR preview, versioned release candidate (RC), or isolated
 * Windows auto-updater test bundle without publishing to any live feed.
 *
 * Usage:
 *   node scripts/build-release.mjs --mode=preview --pr=12 --run-number=5 --output-dir=dist/preview
 *   node scripts/build-release.mjs --mode=rc [--version=0.1.1] [--feed-provider=github|generic|none] [--feed-url=https://...] [--output-dir=dist/rc]
 *   node scripts/build-release.mjs --mode=test-updater --version=0.1.1 --output-dir=... [--skip-vite-build]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyReleaseBundle } from './verify-release-bundle.mjs'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')

function parseCliArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) {
      out[arg.slice(2)] = 'true'
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    }
  }
  return out
}

function assertValidSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid SemVer version: "${version}"`)
  }
}

function sha256FileHex(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase()
}

function sha512FileBase64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

function gitValue(args) {
  const res = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: 'pipe' })
  if (res.status !== 0) return null
  return res.stdout.trim() || null
}

function runStep(command, args, label) {
  const res = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: command !== process.execPath && process.platform === 'win32'
  })
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status}`)
  }
}

function resolveModeConfig(args, baseVersion) {
  const mode = args.mode
  if (!['preview', 'rc', 'test-updater'].includes(mode)) {
    throw new Error('Missing or invalid --mode=preview|rc|test-updater')
  }

  if (mode === 'preview') {
    const pr = String(args.pr ?? '0').replace(/[^0-9]/g, '') || '0'
    const runNum = String(args['run-number'] ?? '0').replace(/[^0-9]/g, '') || '0'
    const version = args.version ?? `${baseVersion}-preview.pr${pr}.${runNum}`
    assertValidSemver(version)
    return {
      mode,
      version,
      appId: 'com.personalvault.preview',
      productName: 'Personal Vault Preview',
      packageName: 'personal-vault-preview',
      artifactName: 'Personal-Vault-Preview-Setup-${version}.${ext}',
      shortcutName: 'Personal Vault Preview',
      createShortcuts: true,
      outputDir: resolve(rootDir, args['output-dir'] ?? 'dist/preview'),
      publish: [
        {
          provider: 'generic',
          url: 'https://updates.invalid/personal-vault/preview-disabled'
        }
      ],
      feedSummary: { provider: 'none', url: null }
    }
  }

  if (mode === 'test-updater') {
    const version = args.version ?? baseVersion
    assertValidSemver(version)
    const feedUrl =
      args['feed-url']?.trim() || 'https://updates.invalid/personal-vault/test-updater'
    return {
      mode,
      version,
      appId: 'com.personalvault.updatertest',
      productName: 'Personal Vault Updater Test',
      packageName: 'personal-vault-updater-test',
      artifactName: 'Personal-Vault-UpdaterTest-Setup-${version}.${ext}',
      shortcutName: 'Personal Vault Updater Test',
      createShortcuts: false,
      outputDir: resolve(rootDir, args['output-dir'] ?? 'dist/test-updater'),
      publish: [
        {
          provider: 'generic',
          url: feedUrl
        }
      ],
      feedSummary: { provider: 'generic', url: feedUrl }
    }
  }

  // Release Candidate ('rc') mode
  const version = args.version || baseVersion
  assertValidSemver(version)
  const feedProvider = (args['feed-provider'] || process.env.PV_UPDATE_FEED_PROVIDER || 'none')
    .trim()
    .toLowerCase()
  const feedUrl = (args['feed-url'] || process.env.PV_UPDATE_FEED_URL || '').trim()

  let publish
  let feedSummary
  if (feedProvider === 'github') {
    publish = [
      {
        provider: 'github',
        owner: 'Inouye165',
        repo: 'personal-vault',
        private: true
      }
    ]
    feedSummary = { provider: 'github', url: 'https://github.com/Inouye165/personal-vault' }
  } else if (feedProvider === 'generic') {
    if (!feedUrl || !/^https:\/\//i.test(feedUrl) || /updates\.invalid/i.test(feedUrl)) {
      throw new Error(
        'RC build with --feed-provider=generic requires a valid non-placeholder https:// --feed-url'
      )
    }
    publish = [
      {
        provider: 'generic',
        url: feedUrl
      }
    ]
    feedSummary = { provider: 'generic', url: feedUrl }
  } else if (feedProvider === 'none') {
    publish = [
      {
        provider: 'generic',
        url: 'https://updates.invalid/personal-vault/win-x64'
      }
    ]
    feedSummary = { provider: 'none', url: null }
  } else {
    throw new Error(`Unsupported --feed-provider="${feedProvider}" (expected github|generic|none)`)
  }

  return {
    mode,
    version,
    appId: 'com.personalvault.app',
    productName: 'Personal Vault',
    packageName: 'personal-vault',
    artifactName: 'Personal-Vault-Setup-${version}.${ext}',
    shortcutName: 'Personal Vault',
    createShortcuts: true,
    outputDir: resolve(rootDir, args['output-dir'] ?? 'dist/rc'),
    publish,
    feedSummary
  }
}

export async function buildReleaseBundle(args) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const cfg = resolveModeConfig(args, pkg.version)
  const skipViteBuild = args['skip-vite-build'] === 'true'

  // 1. Verify pinned VC++ x64 redistributable before packaging NSIS installer.
  runStep(
    process.execPath,
    [join(rootDir, 'scripts', 'fetch-vcredist-x64.mjs'), '--verify-only'],
    'Verify VC++ redistributable'
  )

  // 2. Build Vite bundles unless explicitly skipped.
  if (!skipViteBuild) {
    runStep('npm', ['run', 'build'], 'electron-vite build')
  }

  const workDir = mkdtempSync(join(tmpdir(), `pv-release-${cfg.mode}-`))
  const ebOutDir = join(workDir, 'eb-out')
  const tempConfigPath = join(workDir, 'electron-builder-release.json')

  const builderOverride = {
    extends: 'file:electron-builder.json5',
    appId: cfg.appId,
    productName: cfg.productName,
    extraMetadata: {
      name: cfg.packageName,
      version: cfg.version
    },
    directories: {
      output: ebOutDir,
      buildResources: 'build'
    },
    win: {
      icon: 'build/icon.ico',
      target: [
        {
          target: 'nsis',
          arch: ['x64']
        }
      ]
    },
    nsis: {
      artifactName: cfg.artifactName,
      shortcutName: cfg.shortcutName,
      createDesktopShortcut: cfg.createShortcuts,
      createStartMenuShortcut: cfg.createShortcuts
    },
    publish: cfg.publish
  }
  writeFileSync(tempConfigPath, `${JSON.stringify(builderOverride, null, 2)}\n`, 'utf8')

  try {
    const ebBin = join(
      rootDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
    )
    runStep(
      ebBin,
      ['--win', 'nsis', '--x64', '--publish', 'never', '--config', tempConfigPath],
      `electron-builder (${cfg.mode} ${cfg.version})`
    )

    const builtEntries = readdirSync(ebOutDir)
    const exeName = builtEntries.find((f) => f.endsWith('.exe'))
    const blockmapName = builtEntries.find((f) => f.endsWith('.exe.blockmap'))
    if (!exeName || !blockmapName || !existsSync(join(ebOutDir, 'latest.yml'))) {
      throw new Error(
        `Missing expected NSIS outputs (.exe, .exe.blockmap, latest.yml) in ${ebOutDir}; got: ${builtEntries.join(', ')}`
      )
    }

    rmSync(cfg.outputDir, { recursive: true, force: true })
    mkdirSync(cfg.outputDir, { recursive: true })

    for (const fileName of [exeName, blockmapName, 'latest.yml']) {
      copyFileSync(join(ebOutDir, fileName), join(cfg.outputDir, fileName))
    }

    const artifactList = [exeName, blockmapName, 'latest.yml'].map((fileName) => {
      const fullPath = join(cfg.outputDir, fileName)
      return {
        fileName,
        byteSize: statSync(fullPath).size,
        sha256: sha256FileHex(fullPath),
        sha512: sha512FileBase64(fullPath)
      }
    })

    const sha256Sums = artifactList.map((item) => `${item.sha256}  ${item.fileName}`).join('\n')
    writeFileSync(join(cfg.outputDir, 'SHA256SUMS.txt'), `${sha256Sums}\n`, 'utf8')

    const manifest = {
      schemaVersion: 1,
      mode: cfg.mode,
      version: cfg.version,
      appId: cfg.appId,
      productName: cfg.productName,
      packageName: cfg.packageName,
      feed: cfg.feedSummary,
      gitSha: process.env.GITHUB_SHA || gitValue(['rev-parse', 'HEAD']),
      gitRef: process.env.GITHUB_REF || gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      builtAt: new Date().toISOString(),
      artifacts: artifactList
    }
    writeFileSync(
      join(cfg.outputDir, 'build-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )

    const verified = await verifyReleaseBundle(cfg.outputDir)
    return verified
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint) {
  const args = parseCliArgs(process.argv.slice(2))
  buildReleaseBundle(args)
    .then((summary) => {
      console.log(`[PASS] Built and verified release bundle: ${JSON.stringify(summary)}`)
    })
    .catch((err) => {
      console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}

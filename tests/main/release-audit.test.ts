import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootDir = resolve(__dirname, '../..')

describe('Stage 8C-1 release readiness audit', () => {
  it('documents every direct production dependency in THIRD_PARTY_NOTICES.md', () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const notices = readFileSync(join(rootDir, 'THIRD_PARTY_NOTICES.md'), 'utf8')

    for (const depName of Object.keys(pkg.dependencies)) {
      expect(notices).toContain(depName)
    }
    expect(notices).toContain('electron')
  })

  it('configures Windows x64 NSIS alongside dir with icon, VC++ runtime hook, and user-data preservation', () => {
    const builderConfig = readFileSync(join(rootDir, 'electron-builder.json5'), 'utf8')
    expect(existsSync(join(rootDir, 'build', 'icon.ico'))).toBe(true)
    expect(existsSync(join(rootDir, 'build', 'installer.nsh'))).toBe(true)
    expect(builderConfig).toContain("target: 'dir'")
    expect(builderConfig).toContain("target: 'nsis'")
    expect(builderConfig).toContain("include: 'build/installer.nsh'")
    expect(builderConfig).toContain('deleteAppDataOnUninstall: false')
  })

  it('does not expose OAuth tokens, client secrets, or recovery secrets in startup logs or auth errors', () => {
    const mainIndex = readFileSync(join(rootDir, 'src', 'main', 'index.ts'), 'utf8')
    const logLines = mainIndex
      .split('\n')
      .filter((line) => line.includes('logStartup('))
      .join('\n')

    expect(logLines).not.toMatch(
      /accessToken|refreshToken|clientSecret|recoverySecret|PV_GOOGLE_CLIENT_SECRET|PV_UPDATE_FEED_TOKEN|GH_TOKEN/i
    )

    const driveAuth = readFileSync(
      join(rootDir, 'src', 'main', 'services', 'backup', 'google-drive-auth.ts'),
      'utf8'
    )
    const throwLines = driveAuth
      .split('\n')
      .filter((line) => line.includes('throw new'))
      .join('\n')

    expect(throwLines).not.toMatch(/\$\{.*(token|secret|refresh|verifier)/i)
  })
})

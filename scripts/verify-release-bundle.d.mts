export interface VerifiedReleaseBundle {
  readonly valid: boolean
  readonly bundleDir: string
  readonly mode: string
  readonly version: string
  readonly gitSha: string | null
  readonly exeFileName: string
  readonly blockmapFileName: string
  readonly byteSize: number
  readonly sha256: string
  readonly sha512: string
}

export interface ParsedLatestYml {
  readonly version: string | null
  readonly path: string | null
  readonly sha512: string | null
  readonly releaseDate: string | null
  readonly files: ReadonlyArray<{
    readonly url: string
    readonly sha512: string
    readonly size: number
  }>
}

export function parseLatestYml(content: string): ParsedLatestYml

export function verifyReleaseBundle(
  bundleDir: string,
  options?: {
    readonly expectedTag?: string
  }
): Promise<VerifiedReleaseBundle>

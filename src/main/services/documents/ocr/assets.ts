/**
 * Personal Vault — Packaged Asset Resolution for Stage 7C Offline OCR
 *
 * Maps `app.asar` paths to `app.asar.unpacked` for raw `.wasm` binaries and native
 * addons (`@napi-rs/canvas`, `sharp`) without consulting `process.cwd()`.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface OcrResolvedAssets {
  readonly simdJsPath: string
  readonly simdWasmPath: string
  readonly scalarJsPath: string
  readonly scalarWasmPath: string
  readonly canvasPath: string
  readonly sharpPath: string
  readonly pdfjsStandardFontDataUrl: string
  readonly wasmLoadedFromUnpackedAsar: boolean
}

export interface ResolveOcrAssetsOptions {
  readonly resolvePath?: (specifier: string) => string
}

export function mapAsarToUnpackedPath(targetPath: string): string {
  return targetPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

export function resolveOcrRuntimeAssets(options: ResolveOcrAssetsOptions = {}): OcrResolvedAssets {
  const defaultResolve = (() => {
    const anchorPath =
      typeof __filename === 'string' && __filename.length > 0
        ? __filename
        : join(process.cwd(), 'package.json')
    const req = createRequire(pathToFileURL(anchorPath).href)
    return (specifier: string): string => req.resolve(specifier)
  })()

  const resolveFn = options.resolvePath ?? defaultResolve

  const simdJsPath = resolveFn('tesseract.js-core/tesseract-core-simd-lstm.js')
  const simdWasmPath = mapAsarToUnpackedPath(simdJsPath.replace(/\.js$/, '.wasm'))

  const scalarJsPath = resolveFn('tesseract.js-core/tesseract-core-lstm.js')
  const scalarWasmPath = mapAsarToUnpackedPath(scalarJsPath.replace(/\.js$/, '.wasm'))

  // Keep @napi-rs/canvas on its standard module resolution path (app.asar when packaged) so
  // pdfjs-dist's internal `require('@napi-rs/canvas')` and OCR engine share a single require.cache
  // entry (double-loading @napi-rs/canvas overwrites native Path2D class registration). Electron's
  // ASAR loader still transparently resolves the unpacked native .node binary from app.asar.unpacked.
  const canvasPath = resolveFn('@napi-rs/canvas')
  const sharpPath = mapAsarToUnpackedPath(resolveFn('sharp'))

  const pdfjsPkgJsonPath = resolveFn('pdfjs-dist/package.json')
  const standardFontsDir = join(dirname(pdfjsPkgJsonPath), 'standard_fonts')
  const pdfjsStandardFontDataUrl = `${pathToFileURL(standardFontsDir).href.replace(/\/+$/, '')}/`

  return {
    simdJsPath,
    simdWasmPath,
    scalarJsPath,
    scalarWasmPath,
    canvasPath,
    sharpPath,
    pdfjsStandardFontDataUrl,
    wasmLoadedFromUnpackedAsar:
      simdWasmPath.includes('app.asar.unpacked') || scalarWasmPath.includes('app.asar.unpacked')
  }
}

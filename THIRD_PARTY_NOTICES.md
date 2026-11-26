# Third-Party Notices — Personal Vault

Personal Vault bundles and uses the following open-source runtime components and evaluated model artifacts for offline image decoding, local document extraction and OCR, and local semantic indexing.

---

## 1. ONNX Runtime Node (`onnxruntime-node`)

- **Version**: `1.31.1`
- **License**: MIT License
- **Copyright**: Copyright (c) Microsoft Corporation. All rights reserved.

```text
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Hugging Face Tokenizers (`@huggingface/tokenizers`)

- **Version**: `0.2.0`
- **License**: Apache License, Version 2.0
- **Copyright**: Copyright (c) Hugging Face Inc.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at `http://www.apache.org/licenses/LICENSE-2.0`.

---

## 3. CLIP ViT-B/32 Model (`openai/clip-vit-base-patch32` / `Xenova/clip-vit-base-patch32`)

- **Pinned Revision**: `Xenova/clip-vit-base-patch32@6b7c523703ae26e39be4b03774966f8571c7f523`
- **License**: MIT License
- **Copyright**: Copyright (c) 2021 OpenAI; ONNX conversion by Xenova / Hugging Face.

```text
MIT License

Copyright (c) 2021 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 4. Sharp (`sharp` / `libvips`)

- **License**: Apache License, Version 2.0 (`sharp`), LGPL-3.0-or-later (`libvips`)
- **Copyright**: Copyright 2013 Lovell Fuller and others.

---

## 5. ExifReader (`exifreader`)

- **Version**: `4.54.0`
- **License**: Mozilla Public License, Version 2.0 (MPL-2.0)
- **Copyright**: Copyright (c) Mattias Wallander.

Licensed under the Mozilla Public License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at `https://mozilla.org/MPL/2.0/` and in `node_modules/exifreader/LICENSE`. Unmodified `exifreader` source is bundled into the Personal Vault worker without modification.

---

## 6. libheif-js (`libheif-js`)

- **Version**: `1.23.5`
- **License**: GNU Lesser General Public License, Version 3.0 (LGPL-3.0)
- **Upstream Projects**: `libheif-js` (`https://github.com/catdad-experiments/libheif-js`), `libheif` (`https://github.com/strukturag/libheif`), and `libde265` (LGPL-3.0 HEVC decoder compiled to WebAssembly)

Unmodified `libheif-js` (`libheif-wasm/libheif-bundle.js`) is bundled for offline local HEIC/HEIF decoding in worker threads without uploading personal files or requiring external OS codecs. The installed package includes full license texts in `node_modules/libheif-js/LICENSE` (LGPL-3.0) and `node_modules/libheif-js/libheif-wasm/LICENSE` (`libheif` LGPL-3.0 and bundled component notices; `https://www.gnu.org/licenses/lgpl-3.0.html`). The npm tarball (`libheif-js@1.23.5`) distributes only the compiled JS/WASM artifacts, TypeScript declarations, `README.md`, `package.json`, and `LICENSE` files; corresponding source code resides in the upstream `catdad-experiments/libheif-js` and `strukturag/libheif` repositories (and any public binary distribution of Personal Vault must accompany or offer the matching Corresponding Source under LGPL-3.0 Section 4).

---

## 7. PDF.js (`pdfjs-dist`)

- **Version**: `6.5.438`
- **License**: Apache License, Version 2.0 (`Apache-2.0`)
- **Upstream Project**: `https://github.com/mozilla/pdf.js`

Unmodified `pdfjs-dist` (`legacy/build/pdf.mjs`) is used in a bounded Node worker thread for offline local PDF text extraction without evaluating scripts, loading remote resources, or uploading files. Full license text is included in `node_modules/pdfjs-dist/LICENSE`.

---

## 8. fflate (`fflate`)

- **Version**: `0.8.3`
- **License**: MIT License (`MIT`)
- **Upstream Project**: `https://github.com/101arrowz/fflate`

Unmodified `fflate` is used in a bounded Node worker thread for streaming ZIP decompression of `.docx` containers with strict entry-count and decompressed-byte limits. Full license text is included in `node_modules/fflate/LICENSE`.

---

## 9. fast-xml-parser (`fast-xml-parser`)

- **Version**: `5.12.1`
- **License**: MIT License (`MIT`)
- **Upstream Project**: `https://github.com/NaturalIntelligence/fast-xml-parser`

Unmodified `fast-xml-parser` is used in a bounded Node worker thread to parse `.docx` `word/document.xml` with DTD/entity expansion disabled (`processEntities: false`). Full license text is included in `node_modules/fast-xml-parser/LICENSE`.

---

## 10. Tesseract.js Core (`tesseract.js-core`)

- **Version**: `7.0.0`
- **License**: Apache License, Version 2.0 (`Apache-2.0`), with bundled Leptonica (`BSD-2-Clause`) and permissive image codec notices compiled into WebAssembly
- **Upstream Projects**: `https://github.com/naptha/tesseract.js-core`, `https://github.com/tesseract-ocr/tesseract`, and `http://www.leptonica.org/`

Unmodified `tesseract.js-core` (`tesseract-core-simd-lstm.{js,wasm}` and scalar fallback `tesseract-core-lstm.{js,wasm}`) is loaded directly via `TessBaseAPI` inside a bounded Node worker thread for offline local optical character recognition without nested worker threads or automatic network fetches. Full Apache-2.0 license text is included in `node_modules/tesseract.js-core/LICENSE`. Compiled WASM binaries include Leptonica (`Copyright (C) 2001-2024 Dan Bloomberg`, BSD 2-Clause) and permissive openjpeg/libtiff/zlib/libpng/libjpeg/libwebp subroutines:

```text
Leptonica (BSD 2-Clause License)
Copyright (C) 2001-2024 Dan Bloomberg. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above
   copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials
   provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL ANY
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 11. `@napi-rs/canvas` (`@napi-rs/canvas` / `@napi-rs/canvas-win32-x64-msvc`)

- **Version**: `1.1.1`
- **License**: MIT License (`MIT`) with Chromium asset notice (`BSD-3-Clause`) and statically linked Skia graphics engine (`BSD-3-Clause`)
- **Copyright**: Copyright (c) 2021 LongYinan; Copyright 2015 The Chromium Authors; Copyright (c) 2011 Google Inc.
- **Upstream Projects**: `https://github.com/Brooooooklyn/canvas` and `https://skia.org/`

Unmodified `@napi-rs/canvas` is unpacked under `app.asar.unpacked` and used with `pdfjs-dist` in a bounded Node worker thread for offline local rasterization of PDF pages requiring OCR. Full MIT and Chromium BSD-3-Clause license texts are included in `node_modules/@napi-rs/canvas/LICENSE`:

```text
MIT License

Copyright (c) 2021 LongYinan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
Skia Graphics Library (BSD 3-Clause License)
Copyright (c) 2011 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.
  * Neither the name of Google Inc. nor the names of its contributors
    may be used to endorse or promote products derived from this
    software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 12. Tesseract Fast Language Data (`tesseract-ocr/tessdata_fast` — `eng.traineddata`)

- **Pinned Revision**: `tesseract-ocr/tessdata_fast@65727574dfcd264acbb0c3e07860e4e9e9b22185` (tag `4.1.0`)
- **Artifact**: `eng.traineddata` (`4,113,088` bytes, SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`)
- **License**: Apache License, Version 2.0 (`Apache-2.0`)
- **Copyright**: Copyright (c) Google Inc. and Tesseract OCR contributors (`https://github.com/tesseract-ocr/tessdata_fast`)

Licensed under the Apache License, Version 2.0 (`http://www.apache.org/licenses/LICENSE-2.0`). Language data is never fetched automatically at startup or during OCR runs; it is explicitly imported from a local directory or downloaded upon explicit user initiation and verified against its exact byte length and SHA-256 digest before activation.

---

## 13. BGE Small English v1.5 (ONNX Quantized — `Xenova/bge-small-en-v1.5`, Provisional)

- **Pinned Revision**: `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3` (upstream BAAI `bge-small-en-v1.5` ONNX export)
- **Artifacts**: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `onnx/model_quantized.onnx` (`34,726,996` bytes total, verified per-file byte size and SHA-256)
- **License**: MIT License (`MIT`)
- **Upstream Project**: `https://huggingface.co/BAAI/bge-small-en-v1.5` / `https://huggingface.co/Xenova/bge-small-en-v1.5`

Licensed under the MIT License. Model weights and tokenizer files are not bundled in the application installer and are never fetched automatically; they are optionally provisioned only upon explicit user-initiated offline directory import or explicit download, and verified against exact pinned byte sizes and SHA-256 checksums before use.

---

## 14. React & React DOM (`react`, `react-dom`)

- **Version**: `19.3.1` (`^19.0.0`)
- **License**: MIT License (`MIT`)
- **Copyright**: Copyright (c) Meta Platforms, Inc. and affiliates.
- **Upstream Project**: `https://github.com/facebook/react`

Bundled into the renderer application (`out/renderer`) for UI rendering. Full license text is included in `node_modules/react/LICENSE` and `node_modules/react-dom/LICENSE`.

---

## 15. Lucide React (`lucide-react`)

- **Version**: `1.69.0` (`^1.16.0`)
- **License**: ISC License (`ISC`)
- **Copyright**: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2026 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2026.
- **Upstream Project**: `https://github.com/lucide-icons/lucide`

Bundled into the renderer application (`out/renderer`) for UI icons. Full license text is included in `node_modules/lucide-react/LICENSE`.

---

## 16. Zod (`zod`)

- **Version**: `4.6.7`
- **License**: MIT License (`MIT`)
- **Copyright**: Copyright (c) 2020 Colin McDonnell.
- **Upstream Project**: `https://github.com/colinhacks/zod`

Bundled into main, preload, and renderer processes for runtime schema validation across IPC and persistence boundaries. Full license text is included in `node_modules/zod/LICENSE`.

---

## 17. Electron Updater (`electron-updater`)

- **Version**: `6.8.11` (`^6.8.11`)
- **License**: MIT License (`MIT`)
- **Copyright**: Copyright (c) Vladimir Krivosheev and electron-builder contributors.
- **Upstream Project**: `https://github.com/electron-userland/electron-builder`

Bundled into the Electron main process to check, SHA-512 verify, and install signed or private NSIS application updates upon explicit user approval. Full license text is included in `node_modules/electron-updater/LICENSE`.

---

## 18. Electron Runtime (`electron`) & Chromium / Node.js

- **Version**: `45.2.3`
- **License**: MIT License (`MIT`) for Electron; BSD-3-Clause and third-party notices for Chromium, V8, and Node.js.
- **Copyright**: Copyright (c) Electron contributors, GitHub Inc., OpenJS Foundation, and The Chromium Authors.

Packaged desktop distributions include `LICENSE.electron.txt` and `LICENSES.chromium.html` alongside the application executable.

---

## 19. Transitive Runtime Dependencies

All transitive production runtime dependencies resolved in `package-lock.json` (including `onnxruntime-common`, `detect-libc`, `scheduler`, `@img/colour`, `@img/sharp-win32-x64`, `@napi-rs/canvas-win32-x64-msvc`, `@emnapi/runtime`, `@xmldom/xmldom`, `strnum`, `fast-xml-builder`, `builder-util-runtime`, `fs-extra`, `js-yaml`, `lazy-val`, `lodash.escaperegexp`, `lodash.isequal`, `semver`, `tiny-typed-emitter`, and supporting utilities) are licensed under permissive MIT, ISC, Apache-2.0, BSD-3-Clause, or CC0-1.0 licenses, except `libvips` (`@img/sharp-libvips-*` / `@img/sharp-win32-x64`, LGPL-3.0-or-later) and `libheif-js` (LGPL-3.0) noted in Sections 4 and 6 above.

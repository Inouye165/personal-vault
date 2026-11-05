# Personal Vault

Personal Vault is a privacy-first, offline desktop catalog and vault application designed to discover photographs and documents, support review and classification, and copy selected originals into a secured vault.

Personal Vault guarantees strict source file preservation: discovered originals are never modified, edited, or moved during discovery, indexing, or classification.

---

## Prerequisites

- **Node.js**: `v20.0.0` or higher (tested on Node `v22.18.0`)
- **npm**: `v10.0.0` or higher (tested on npm `v10.9.3`)
- **OS**: Windows, macOS, or Linux

---

## Setup & Installation

Clone or open the repository at `D:\organizer`, then install dependencies:

```bash
npm install
```

---

## Development

Run the Electron and React development environment with Hot Module Replacement (HMR):

```bash
npm run dev
```

---

## Verification & Quality Gates

Run the automated test suite and code quality gates:

```bash
# Run unit and behavioral tests (Vitest + jsdom)
npm test

# Run strict TypeScript type checking across Node and Web targets
npm run typecheck

# Check linting rules (ESLint)
npm run lint

# Check formatting compliance (Prettier)
npm run format:check

# Auto-format codebase
npm run format
```

### Runtime verification (real Electron)

A visible window is **not** proof that the app works: a broken preload still shows a window. The smoke check launches the real app on a temporary user-data directory, attaches over the DevTools protocol, and verifies that `window.api` exists, its methods return the expected values across IPC, the UI reaches the confirmed empty state, hostile navigation and popups are blocked, and no preload, renderer, or console errors occur. It exits non-zero with the reasons on failure, is bounded by a timeout, and terminates only the process tree it started.

```bash
npm run smoke:dev        # electron-vite dev server + Electron
npm run build && npm run smoke:built
npm run build:unpack && npm run smoke:unpacked
```

Add `-- --screenshot=name.png` after the script name (for example `npm run smoke:built -- --screenshot=shell.png`) to also save a screenshot; `smoke-*.png` files are git-ignored, other names are not.

---

## Production Build & Packaging

Build the production bundles for Electron main, preload, and the React renderer:

```bash
npm run build
```

Package an unpacked desktop application directory:

```bash
npm run build:unpack
```

The output executable is generated at:

- `dist/win-unpacked/Personal Vault.exe` (on Windows)

---

## Architecture at a Glance

- **Process Isolation**: Electron main process handles OS APIs; preload uses `contextBridge` to expose a narrowly-scoped `window.api`; renderer runs sandboxed React with zero Node.js access.
- **Runtime Validation**: All IPC channels and payloads crossing process boundaries are verified using Zod schemas.
- **Content Security Policy**: Scripts are limited to `'self'` (no remote code); the development server additionally allows its own inline preamble by hash.

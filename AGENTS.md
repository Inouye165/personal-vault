# Personal Vault engineering instructions

Work from the active repository checkout. Use an isolated checkout for new work and leave the older `D:\organizer` checkout read-only.

## Branches and test builds

- Start a task-specific branch from current `main` before editing. Continue existing work on its task branch. Commit and push only to that branch and open a pull request into `main`. Merge after Ron approves. Keep production releases separate from branch testing.
- Give Ron a clearly identified Electron test build from the branch, with the commit SHA, launch path, and short test steps. Use an isolated app profile, catalog, vault and sample files. Verify those paths before handing it over. An unpacked desktop build works for UI review. Use an isolated installer candidate when testing installation.

## User experience

- Write for someone using Personal Vault for the first time. Use plain language that tells them what they can do, what is happening, and what to do next.
- Give each setup or recovery state one clear action where the user encounters it. Keep implementation terms in advanced settings or details. Distinguish optional setup, work in progress, and a failure that needs attention.
- Show controls when they are usable. If a control must stay visible while unavailable, explain why and offer the next action. Keep already-available work accessible during setup.
- Make status and recovery clear through text as well as visual styling. Check keyboard use, focus, and readability at narrow and normal window widths.

## Source files and privacy

- Keep originals read-only during discovery, classification and import. Never alter, overwrite, touch or move them. Never automate source deletion, including during deduplication.
- Record the exact original filename, absolute path, filesystem creation and modification timestamps, byte size and SHA-256 as immutable facts. Keep derived dates, locations, classifications and tags separate. Leave capture date and location unknown when evidence is absent.
- Treat removing a catalog entry, deleting a vault copy and deleting an original as separate operations. Original deletion requires explicit, guarded user confirmation.
- Verify the hash before reporting a successful vault copy. Preserve metadata in portable sidecars or catalog backups. Keep personal files, metadata and extracted content on-device unless the user explicitly enables a feature that sends them elsewhere.

## Electron boundaries and security

- Keep native operations and background jobs in `src/main`, the narrow typed `window.api` bridge in `src/preload`, and Zod contracts in `src/shared`. The React renderer in `src/renderer` has no direct Node or filesystem access.
- Keep `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. Bundle all preload dependencies except `electron`.
- Validate incoming and outgoing IPC payloads and acknowledgements with Zod. Each handler verifies the sending WebContents, top-level frame and trusted app URL.
- Allow navigation only to the packaged app document or the single configured development origin. Deny popups and arbitrary URLs in `shell.openExternal`. Enforce CSP in response headers and the app meta tag:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self';
  ```

## Verification and scope

- Stay within the assigned scope. Start behavior changes with a failing test, implement the smallest complete fix, then refactor.
- Run `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check`. Build before testing in a clean checkout so the generated document classification worker exists. See [README.md](README.md) and [package.json](package.json) for specialized checks. For Windows line-ending mismatches, also check changed files with Prettier and report any baseline failures.
- For runtime changes, verify the real Electron bridge with the applicable smoke check and exercise the changed user flow. Confirm IPC results and check for preload and renderer errors.
- Keep architecture, handoff, task and README documentation accurate where the change affects them. Record which checks ran and any gaps.

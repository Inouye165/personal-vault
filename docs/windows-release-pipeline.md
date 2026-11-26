# Windows app updates

Personal Vault checks its configured private update feed at startup. **Check for updates** is also available next to the version in the sidebar. If a newer build is available, **Update now** downloads it and restarts Personal Vault after active vault writes and backups finish. **Later** leaves the running version in use. A failed check or download can be retried.

## Move an existing installation onto the update feed

Install the first updater-enabled Windows build manually. The original 0.1.0 installer predates the updater. Close Personal Vault before running the new installer and use the same installation location. The regular catalog and vault stay in their existing locations.

## Prepare a private release

Build from the approved source with a version greater than the installed version. For a private HTTPS feed, substitute the version and base URL below.

```powershell
npm run build:release -- --mode=rc --version=0.1.1 --feed-provider=generic --feed-url=https://your-private-host/personal-vault/win-x64 --output-dir=dist/rc
npm run verify:release-bundle -- --bundle-dir=dist/rc --expected-tag=v0.1.1
```

Verify the installer using the SHA-256 in `SHA256SUMS.txt`. Publish the tested installer and blockmap to the approved private host, then publish its matching `latest.yml` last. The manifest points the updater at the installer and supplies its SHA-512. Keep the same feed URL for later versions. A machine that can reach the feed may check for updates even when the catalog is empty.

A build with no configured feed makes no update requests. For a private feed that uses bearer authentication, supply `PV_UPDATE_FEED_TOKEN` at runtime. Keep credentials out of the build and the feed URL. Preview/test builds use separate app identities. Run `npm run verify:updater` for the isolated three-step Windows installer test (`0.1.0` -> manual `0.1.1` -> in-app `0.1.2`) before distributing an updater-enabled build.

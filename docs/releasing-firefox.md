# Publishing a Firefox build

The native host only trusts the extension ID `open-claude-in-chrome@hrideshmg.com`,
and only the AMO account that owns that ID can sign it, so every user installs the
one build published here.

1. Bump `version` in `extension/manifest.json`.
2. Sign it as unlisted (keys from addons.mozilla.org/developers/addon/api/key/):

   ```bash
   WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… \
     nix run nixpkgs#web-ext -- sign -s extension --channel unlisted -a /tmp/ocic-signed
   ```

   `npx web-ext sign …` works without Nix.
3. Attach the `.xpi` to a release tagged `v<version>`, always named
   `open-claude-in-chrome.xpi` so the README's download link points at the newest build:

   ```bash
   cp /tmp/ocic-signed/*-<version>.xpi /tmp/open-claude-in-chrome.xpi
   gh release create v<version> /tmp/open-claude-in-chrome.xpi
   ```

4. Add the version to `updates.json` on `main`, linking to that release's asset.
   Installed copies check it through `update_url` in the manifest.

For development, load `extension/manifest.json` from
`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…*. Firefox drops
temporary add-ons on restart, so `restart_browser` drops it too.

# Audit UI dev harness

Not shipped. It exists so the Audits pane can be designed and reviewed without
reloading the extension for every tweak — same markup and tokens as
`extension/recorder/options.html`, so porting it back is a copy, not a rewrite.

    python3 -m http.server 8860        # from the REPO ROOT
    open http://localhost:8860/scratch/audit-ui/

It reads `fixtures/index.json` (`{"files": ["audit.json", ...]}`) and each named
file, which are `audit.json` bundles the extension checkpoints to
`~/.config/open-claude-in-chrome/audits/<sessionId>/`. Refresh fixtures with:

    ./scratch/audit-ui/sync-fixtures.sh

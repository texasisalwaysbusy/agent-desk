# Publishing Agent Desk

The public project name is Agent Desk and the intended repository slug is agent-desk.
No remote repository is created or selected by the export command. The GitHub owner
and visibility must be verified before upload. Keep the upstream URL only as source
attribution; never push this work to the original author's repository.

## Prepare a reviewed snapshot

```powershell
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
npm run app:build:windows
npm run app:verify-packaged-taskctl
python scripts/export-public-source.py
```

The export is written to a new directory under dist/public-source/ and a matching ZIP.
It includes source, lockfiles, tests, public documentation, LICENSE and NOTICE. It
excludes Git history, local agent state, runtime descriptors, task data, logs, dependencies,
packaged applications, internal deployment records and machine-specific documents.
The accompanying manifest records relative filenames and SHA-256 hashes.
Automated checks catch selected sensitive-file and credential patterns; they are not
proof that every kind of private information is absent. Review the entire manifest
and public-facing documentation before creating a clean public repository.

## Release gates

- Source checks and the Windows package must pass, with skipped checks reported.
- Public stable packages must use a stable product version and the Release build
  profile, with the GitHub release neither draft nor prerelease. Keep sanitized
  startup/error logs; do not change accepted runtime behavior just to remove logs.
  A user-retained local rc installation must not be overwritten as a publication
  side effect.
- Verify the new installer and icon in the actual host; source tests do not replace this.
- Test clean installation and legacy-store reuse without running both launchers.
- Verify core tasks, conversation navigation, dashboard and failure states.
- Verify approval integration separately; fixture tests do not prove human approval execution.
- Keep the old installation and data as rollback until real acceptance is complete.
- Record unsigned status and installer SHA-256. Do not describe a local build as signed.
- Retain upstream attribution and dependency notices, including bundled font and Gantt CSS.
- Include LICENSE, NOTICE, licenses/Apache-2.0.txt and docs/licensing.md; describe covered Agent Desk changes as source-available with Commons Clause 1.0, never Apache-only.
- Discard earlier Apache-only source snapshots as publication inputs; never push their commits or binaries as this licensed release.
- Upload only after confirming the destination owner, repository name and visibility.

For 1.2.2, the installed rc.6 acceptance covers the same runtime implementation;
stable promotion changes product version metadata and public documentation only.
Rebuild and verify the stable installer payload and packaged service. Do not repeat
accepted host flows without a new change or failure; keep the observed and unknown
items explicit in the release notes.

Repository initialization and upload are deliberately separate from source preparation.
The local development checkout keeps upstream history for audit; it is not the public
snapshot. Never force-push, rewrite that history or delete local records just to publish.

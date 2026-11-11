# Changelog

## 0.2.0

- Support Moshi workspace tabs without installing or running herdr-app. `/hfork` registers the new terminal in the shared layout stored by herdr-core, so Moshi can show the named fork in its sidebar.
- Preserve herdr-app tab adoption, naming, and focus behavior when a local app window is running.
- Resolve Pi to an absolute executable path before launch, allowing forks to start when the core daemon has a minimal `PATH`.
- Preserve existing layout fields and concurrent edits through versioned document writes. Retry explicit version conflicts; report uncertain failures with the fork's recovery information.
- Keep forked conversations independent of the source terminal and leave the source conversation unchanged.
- Add regression coverage for headless registration and concurrent edits, real-core integration checks for both modes, and an opt-in check against Moshi's live sidebar API.

After updating, run `/reload` in existing Pi sessions to load the new command.

# Release Policy

The repository is public and the initial public package release is `0.1.0` under MIT.

Before publishing a release:

1. Run `corepack pnpm install --frozen-lockfile`, `corepack pnpm lint`, `corepack pnpm test`, and `corepack pnpm build`.
2. Pack the package and install it in a clean consumer fixture.
3. Verify callback-hosted stdio `initialize`, `tools/list`, and `tools/call` flows without live message data.
4. Compile the helper and run its missing-database dispatch smoke on macOS.
5. Update `CHANGELOG.md` and compatibility notes.
6. Create and push a `v*` tag. The release workflow publishes with npm provenance and creates GitHub release notes.

The `publish` GitHub Actions environment must be connected to npm as a trusted publisher for
`@motionsmith/apple-messages-mcp`. No registry token belongs in this repository.

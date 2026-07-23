# Agent Context

This repository is the standalone Apple Messages MCP protocol library and local macOS helper toolkit.

## Repository Shape

- Root package manager: `pnpm` via Corepack.
- Public package: `@motionsmith/apple-messages-mcp`.
- Library entry point: `src/index.ts`.
- Reusable helper source: `helper/apple-messages-helper.swift`.
- Helper app template: `scripts/`.
- Consumer examples: `examples/`.

## Commands

- `corepack pnpm install`
- `corepack pnpm test`
- `corepack pnpm build`
- `corepack pnpm lint`
- `corepack pnpm pack`

## Boundary

- Keep the package library-first: the consumer provides status, setup, and optional bounded context callbacks.
- Do not add Sugar config, traces, Home, Operator Ask, household model, approval, or transcript persistence policy.
- Keep fixtures, tests, documentation, and CI free of raw message bodies, contact data, chat GUIDs, attachment contents, and lookup queries.
- The helper uses the local Mac's `chat.db`; macOS Full Disk Access belongs to the compiled host app identity.

## Safety

- Do not commit secrets, `.env*`, live Apple Messages data, generated package artifacts, `dist/`, `bin/`, or `node_modules/`.
- Automated tests use fixtures and temporary paths. Live Apple Messages reads are manual play tests only.

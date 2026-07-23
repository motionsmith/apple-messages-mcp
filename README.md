# Apple Messages MCP

`@motionsmith/apple-messages-mcp` is a library-first MCP protocol and reusable local macOS helper
toolkit for Apple Messages. It is for any consumer that can host a stdio MCP server and provide its
own status, watch setup, and optional bounded context callbacks. It is not a configuration store,
approval system, transcript database, or Sugar integration.

Apple Messages data stays on the local Mac. The helper reads the local `chat.db`; the app that
compiles and runs it needs macOS Full Disk Access. This package never bypasses macOS privacy.

## Install

```sh
corepack pnpm add @motionsmith/apple-messages-mcp@0.1.0
```

The package supports Node 20 or newer and is useful for live helper work only on macOS. The
library's fixture and protocol APIs are cross-platform.

## Host the stdio MCP server

The consumer owns callbacks and their policies. In particular, it decides whether setup writes
configuration, whether a user approves that write, what a status response contains, and whether
bounded context is persisted or displayed.

```js
import { runAppleMessagesMcpStdioServer } from '@motionsmith/apple-messages-mcp';

await runAppleMessagesMcpStdioServer({
  callbacks: {
    status: async () => ({ status: 'not_configured' }),
    setup: async ({ watch, candidate, alias, approve }) => {
      // Resolve and store a watch in this application's own configuration.
      return { status: 'dry_run', watch, candidate, alias, approve: approve === true };
    },
    readContext: async ({ conversationRef, limit = 5 }) => {
      // Read only this application's configured opaque ref, bounded by `limit`.
      return { status: 'ready', conversationRef, limit, messages: [] };
    },
  },
});
```

This server reads newline-delimited JSON-RPC on stdin and writes newline-delimited JSON-RPC on
stdout. The package intentionally has no default executable: a consumer cannot use it safely
without owning those callbacks.

## Protocol v1

The MCP server handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
Tool calls are:

- `messages_status` — calls the consumer's `status` callback.
- `setup_messages_watch` — calls `setup` with `watch`, optional opaque `candidate`, optional
  `alias`, and explicit `approve: true` only when supplied.
- `read_messages_context` — calls optional `readContext` with a required opaque
  `apple_messages_conversation_*` ref and a limit from 1 through 20.

Candidate payloads are validated and capped at five. Invalid requests and callback failures produce
sanitised MCP errors. The library normalizes fixture or helper rows to opaque refs and hashes; it
does not emit raw message bodies, handles, chat GUIDs, lookup queries, or attachment contents.
See [the compatibility policy](docs/compatibility.md).

## Helper template

The reusable helper source is `helper/apple-messages-helper.swift`; its protocol commands are
`messages-candidates`, `messages-validate`, and `messages-read`. Build the default standalone host
app on macOS:

```sh
corepack pnpm helper:build
```

This creates `bin/Apple Messages MCP Host.app`, bundle id
`com.motionsmith.apple-messages-mcp.host`. Grant that app Full Disk Access in System Settings >
Privacy & Security before a live `chat.db` read. A consumer may compile the included source into
its own host app identity; it then owns installation and recovery language for that identity.

## Safe fixture verification

Use the supplied consumer example after installing from a packed artifact. It hosts callbacks only
and does not read live Apple Messages data:

```sh
corepack pnpm exec node examples/consumer-smoke.mjs --stdio <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"messages_status","arguments":{}}}
EOF
```

Expected results include the `apple-messages` server info, the three protocol-v1 tools, and a
`not_configured` callback response. Configure a non-sensitive test thread only for a manual live
smoke. Do not add raw messages or contact identifiers to fixtures, screenshots, CI logs, issue
reports, or package documentation.

## Development and releases

```sh
corepack pnpm install
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm pack
```

CI runs the frozen install, lint, tests, TypeScript build, package-content check, and the macOS
helper compile/dispatch smoke. Tag releases use npm provenance after the repository's `publish`
environment has been configured as the npm trusted publisher. See
[release policy](docs/release-policy.md) and [CHANGELOG.md](CHANGELOG.md).

## Notices

This package is not affiliated with Apple or OpenAI. Apple Messages and macOS are Apple platforms.
Codex and OpenAI are separate products and services.

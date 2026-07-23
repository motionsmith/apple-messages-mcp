# Compatibility Policy

`@motionsmith/apple-messages-mcp` follows semantic versioning.

Protocol v1 comprises the MCP JSON-RPC dispatcher, the `messages_status`,
`setup_messages_watch`, and `read_messages_context` tool names and schemas, opaque
`apple_messages_conversation_*` references, five-candidate ambiguity cap, sanitised error
envelopes, helper `messages-candidates`, `messages-validate`, and `messages-read` commands, and
redacted normalized records.

- Patch releases preserve the complete v1 contract.
- Minor releases add only backward-compatible API or tool surface.
- A breaking tool, schema, helper protocol, or privacy-contract change requires a new major
  contract with migration notes in this file and the release notes.

Consumers own configuration, persistence, approvals, display, and any transcript retention. This
package must not infer those policies.

import {
  handleAppleMessagesMcpRequest,
  runAppleMessagesMcpStdioServer,
} from '@motionsmith/apple-messages-mcp';

const callbacks = {
  status: async () => ({ status: 'not_configured' }),
  setup: async ({ watch, candidate, alias, approve }) => ({
    status: 'dry_run',
    watch,
    candidate,
    alias,
    approve: approve === true,
  }),
  readContext: async ({ conversationRef, limit = 5 }) => ({
    status: 'ready',
    conversationRef,
    limit,
    messages: [],
  }),
};

if (process.argv.includes('--stdio')) {
  await runAppleMessagesMcpStdioServer({ callbacks });
} else {
  console.log(
    await handleAppleMessagesMcpRequest(
      { method: 'tools/list' },
      callbacks
    )
  );
}

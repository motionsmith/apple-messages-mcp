import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import {
  handleAppleMessagesMcpRequest,
  normalizeAppleMessagesFixtureReadResult,
  parseAppleMessagesCandidates,
} from './index';

const execFileAsync = promisify(execFile);

describe('Apple Messages MCP provider boundary', () => {
  it('keeps the provider independent of consumer config, traces, and command code', async () => {
    const source = await fs.readFile(path.join(__dirname, 'index.ts'), 'utf8');

    expect(source).not.toMatch(/@sugar\/(config|traces)/);
    expect(source).not.toMatch(/apps\/cli|appleMessagesSetup|sourceObservation|Sugar Mac Host/);
  });

  it('normalizes fixture rows without leaking raw conversation, sender, or message content', () => {
    const result = normalizeAppleMessagesFixtureReadResult({
      conversation: { label: 'Test conversation', refSeed: 'private-chat-guid' },
      rows: [
        {
          messageId: '42',
          chatGuid: 'private-chat-guid',
          isFromMe: false,
          handleValue: '+15551234567',
          text: 'PRIVATE BODY',
          sentAt: '2026-07-04T16:00:00.000Z',
        },
      ],
    });

    expect(result.messages[0]?.conversation.ref).toMatch(
      /^apple_messages_conversation_[a-f0-9]{32}$/
    );
    expect(JSON.stringify(result)).not.toContain('private-chat-guid');
    expect(JSON.stringify(result)).not.toContain('+15551234567');
    expect(JSON.stringify(result)).not.toContain('PRIVATE BODY');
  });

  it('bounds and validates opaque candidate payloads', () => {
    const ref = 'apple_messages_conversation_0123456789abcdef0123456789abcdef';
    expect(
      parseAppleMessagesCandidates({
        status: 'ready',
        candidates: Array.from({ length: 6 }, () => ({
          candidateRef: ref,
          label: 'Conversation',
          matchKind: 'query_match',
        })),
      })
    ).toHaveLength(5);
  });

  it.skipIf(process.platform !== 'darwin')(
    'reports opaque-ref validation permission failures without calling the conversation missing',
    async () => {
      const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'sugar-messages-helper-permission-')
      );
      const inputPath = path.join(temporaryDirectory, 'request.json');
      await fs.writeFile(
        inputPath,
        JSON.stringify({
          databasePath: temporaryDirectory,
          conversationRef: 'apple_messages_conversation_0123456789abcdef0123456789abcdef',
        })
      );

      try {
        await expect(
          execFileAsync('/usr/bin/swift', [
            path.join(__dirname, '..', 'helper', 'apple-messages-helper.swift'),
            'messages-read',
            '--input-file',
            inputPath,
          ])
        ).rejects.toMatchObject({
          code: 3,
          stdout: expect.stringContaining('"status":"missing_permission"'),
        });
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  );

  it('dispatches generic MCP calls through injected consumer callbacks', async () => {
    const result = await handleAppleMessagesMcpRequest(
      { method: 'tools/call', params: { name: 'messages_status', arguments: {} } },
      { status: async () => ({ status: 'not_configured' }), setup: async () => ({}) }
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured' }) }],
    });
  });
});

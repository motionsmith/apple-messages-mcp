import { execFile } from 'child_process';
import { createHash } from 'crypto';
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

    expect(source).not.toMatch(/apps\/cli|appleMessagesSetup|sourceObservation/);
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
    'normalizes phone identifiers and ranks the recently active chat first',
    async () => {
      const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'apple-messages-helper-candidates-')
      );
      const databasePath = path.join(temporaryDirectory, 'chat.db');
      const inputPath = path.join(temporaryDirectory, 'request.json');
      const currentGuid = 'current-private-chat-guid';
      const participantGuid = 'participant-private-chat-guid';
      await execFileAsync('/usr/bin/sqlite3', [
        databasePath,
        `
          CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, chat_identifier TEXT);
          CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
          CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
          CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
          CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, handle_id INTEGER);
          INSERT INTO chat VALUES (1, 'old-private-chat-guid', NULL, '+1 (206) 555-0100');
          INSERT INTO chat VALUES (2, '${currentGuid}', NULL, 'current-private-chat');
          INSERT INTO chat VALUES (3, '${participantGuid}', NULL, 'participant-private-chat');
          INSERT INTO chat VALUES (4, 'date-private-chat-guid', NULL, '20260723');
          INSERT INTO chat VALUES (5, 'international-private-chat-guid', NULL, 'international-private-chat');
          INSERT INTO handle VALUES (1, '+12065550100');
          INSERT INTO handle VALUES (2, '+442071234567');
          INSERT INTO message VALUES (1, 100, NULL);
          INSERT INTO message VALUES (2, 200, 1);
          INSERT INTO message VALUES (3, 150, NULL);
          INSERT INTO message VALUES (4, 300, NULL);
          INSERT INTO message VALUES (5, 400, 2);
          INSERT INTO chat_message_join VALUES (1, 1);
          INSERT INTO chat_message_join VALUES (2, 2);
          INSERT INTO chat_message_join VALUES (3, 3);
          INSERT INTO chat_message_join VALUES (4, 4);
          INSERT INTO chat_message_join VALUES (5, 5);
          INSERT INTO chat_handle_join VALUES (3, 1);
        `,
      ]);
      await fs.writeFile(
        inputPath,
        JSON.stringify({ databasePath, query: '+1 (206) 555-0100', limit: 5 })
      );

      try {
        const { stdout } = await execFileAsync('/usr/bin/swift', [
          path.join(__dirname, '..', 'helper', 'apple-messages-helper.swift'),
          'messages-candidates',
          '--input-file',
          inputPath,
        ]);
        const result = JSON.parse(stdout) as {
          status: string;
          candidates: Array<{ candidateRef: string; matchKind: string }>;
        };

        expect(result.status).toBe('ready');
        expect(result.candidates).toEqual([
          {
            candidateRef: `apple_messages_conversation_${createHash('sha256').update(currentGuid).digest('hex')}`,
            label: 'Conversation 1',
            matchKind: 'query_match',
          },
          {
            candidateRef: `apple_messages_conversation_${createHash('sha256').update(participantGuid).digest('hex')}`,
            label: 'Conversation 2',
            matchKind: 'query_match',
          },
          {
            candidateRef: `apple_messages_conversation_${createHash('sha256').update('old-private-chat-guid').digest('hex')}`,
            label: 'Conversation 3',
            matchKind: 'exact_label',
          },
        ]);

        for (const query of ['2026-07-23', '+12071234567']) {
          await fs.writeFile(inputPath, JSON.stringify({ databasePath, query, limit: 5 }));
          const { stdout: unmatchedStdout } = await execFileAsync('/usr/bin/swift', [
            path.join(__dirname, '..', 'helper', 'apple-messages-helper.swift'),
            'messages-candidates',
            '--input-file',
            inputPath,
          ]);
          expect(JSON.parse(unmatchedStdout).candidates).toEqual([]);
        }
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
    20_000
  );

  it.skipIf(process.platform !== 'darwin')(
    'reports opaque-ref validation permission failures without calling the conversation missing',
    async () => {
      const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'apple-messages-helper-permission-')
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
    },
    20_000
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

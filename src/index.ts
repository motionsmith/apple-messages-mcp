import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import { stdin as defaultStdin, stdout as defaultStdout } from 'process';

export const APPLE_MESSAGES_PROVIDER_VERSION = '0.1.1';
export const MAX_APPLE_MESSAGES_CANDIDATES = 5;

export type AppleMessagesReadStatus =
  | 'ready'
  | 'unsupported'
  | 'missing_config'
  | 'missing_permission'
  | 'failed';
export type AppleMessagesDirection = 'inbound' | 'outbound';
export type AppleMessagesContentMode = 'hash_only' | 'metadata_only';

export interface AppleMessagesSourceReadInput {
  scope: string;
  sourceId: string;
  conversationLabel: string;
  conversationRef?: string;
  maxMessages: number;
}

export type AppleMessagesSourceRead = (
  input: AppleMessagesSourceReadInput
) => Promise<AppleMessagesReadResult>;

export interface AppleMessagesReadResult {
  schemaVersion: 1;
  status: AppleMessagesReadStatus;
  messages: NormalizedAppleMessage[];
  providerCursor?: string;
  findings: string[];
}

export interface NormalizedAppleMessage {
  source: 'apple_messages';
  id: string;
  conversation: { ref: string; label: string };
  direction: AppleMessagesDirection;
  service: 'iMessage' | 'SMS' | 'unknown' | string;
  sentAt: string;
  senderRef?: string;
  attachmentCount: number;
  content: { mode: AppleMessagesContentMode; hash?: string };
  editedAt?: string;
  deletedAt?: string;
  unsupported: { reactions: boolean };
}

export interface AppleMessagesFixtureReadInput {
  conversation: { label: string; refSeed?: string };
  rows: AppleMessagesFixtureRow[];
}

export interface AppleMessagesFixtureRow {
  messageId: string;
  chatGuid: string;
  isFromMe: boolean;
  service?: string;
  sentAt: string;
  handleValue?: string;
  text?: string;
  attachmentCount?: number;
  editedAt?: string;
  deletedAt?: string;
  hasReactions?: boolean;
}

export interface AppleMessagesSqliteRow {
  messageId: number | string;
  chatGuid: string;
  isFromMe: number | string | boolean;
  service?: string | null;
  appleDate: number | string | null;
  handleValue?: string | null;
  text?: string | null;
  attachmentCount?: number | string | null;
  dateEdited?: number | string | null;
  dateDeleted?: number | string | null;
}

export interface AppleMessagesCandidate {
  candidateRef: string;
  label: string;
  matchKind: 'exact_label' | 'query_match' | 'contact_match';
}

export interface AppleMessagesHelperPayload {
  schemaVersion?: number;
  kind?: string;
  status?: AppleMessagesReadStatus;
  rows?: AppleMessagesSqliteRow[];
  candidates?: unknown[];
  findings?: string[];
}

export interface AppleMessagesHelperReadOptions {
  invoke: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AppleMessagesChatDbReadOptions {
  databasePath?: string;
  runner: (
    command: string,
    args: string[],
    options: { timeoutMs?: number }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  timeoutMs?: number;
}

export function isAppleMessagesConversationRef(value: string): boolean {
  return /^apple_messages_conversation_[a-f0-9]{32,64}$/.test(value);
}

export function normalizeAppleMessagesFixtureReadResult(
  input: AppleMessagesFixtureReadInput
): AppleMessagesReadResult {
  const conversationSeed =
    input.conversation.refSeed ?? input.rows[0]?.chatGuid ?? `fixture:${input.conversation.label}`;
  const conversationRef = `apple_messages_conversation_${hashText(conversationSeed).slice(0, 32)}`;
  const messages = input.rows
    .map((row) => normalizeFixtureRow(row, input.conversation.label, conversationRef))
    .sort(
      (left, right) => left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id)
    );
  return {
    schemaVersion: 1,
    status: 'ready',
    messages,
    providerCursor: providerCursorForMessages(messages),
    findings: [],
  };
}

export function normalizeAppleMessagesHelperReadResult(
  payload: unknown,
  conversationLabel: string,
  readerLabel = 'Apple Messages host helper'
): AppleMessagesReadResult {
  const helper = parseHelperPayload(payload);
  if (helper === undefined)
    return failedRead('Apple Messages host helper returned malformed JSON.');
  if (helper.status !== 'ready') {
    return {
      schemaVersion: 1,
      status: helper.status ?? 'failed',
      messages: [],
      findings: nonEmptyFindings(
        helper.findings,
        `Apple Messages host helper failed before producing normalized records: ${helper.status ?? 'failed'}`
      ),
    };
  }
  return appleMessagesReadResultFromSqliteRows(helper.rows ?? [], conversationLabel, readerLabel);
}

export async function readAppleMessagesHelper(
  input: AppleMessagesSourceReadInput,
  options: AppleMessagesHelperReadOptions
): Promise<AppleMessagesReadResult> {
  return normalizeAppleMessagesHelperReadResult(
    await options.invoke({
      ...(input.conversationRef === undefined
        ? { conversationLabel: input.conversationLabel }
        : { conversationRef: input.conversationRef }),
      maxMessages: input.maxMessages,
    }),
    input.conversationLabel
  );
}

export function createAppleMessagesChatDbRead(
  options: AppleMessagesChatDbReadOptions
): AppleMessagesSourceRead {
  const databasePath =
    options.databasePath ?? path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  const timeoutMs = options.timeoutMs ?? 5_000;
  return async (input) => {
    try {
      await fs.access(databasePath);
    } catch (error) {
      const status = isPermissionError(error) ? 'missing_permission' : 'failed';
      return failedWithStatus(
        status,
        status === 'missing_permission'
          ? 'Apple Messages chat.db is not readable; grant Full Disk Access to the configured Apple Messages host app.'
          : 'Apple Messages chat.db was not found at the expected local path.'
      );
    }
    const response = await options.runner(
      'sqlite3',
      ['-readonly', '-json', databasePath, messagesSql(input.conversationLabel, input.maxMessages)],
      { timeoutMs }
    );
    if (response.exitCode !== 0) {
      const status = sqliteFailureStatus(response.stderr);
      return failedWithStatus(status, sqliteFailureFinding(status));
    }
    try {
      const rows =
        response.stdout.trim().length === 0
          ? []
          : (JSON.parse(response.stdout) as AppleMessagesSqliteRow[]);
      return normalizeAppleMessagesHelperReadResult(
        { status: 'ready', rows },
        input.conversationLabel,
        'chat.db reader'
      );
    } catch {
      return failedRead('Apple Messages chat.db reader returned malformed JSON.');
    }
  };
}

export function parseAppleMessagesCandidates(payload: unknown): AppleMessagesCandidate[] {
  const candidates = parseHelperPayload(payload)?.candidates ?? [];
  return candidates
    .filter(
      (candidate): candidate is AppleMessagesCandidate =>
        isRecord(candidate) &&
        typeof candidate.candidateRef === 'string' &&
        isAppleMessagesConversationRef(candidate.candidateRef) &&
        typeof candidate.label === 'string' &&
        (candidate.matchKind === 'exact_label' ||
          candidate.matchKind === 'query_match' ||
          candidate.matchKind === 'contact_match')
    )
    .slice(0, MAX_APPLE_MESSAGES_CANDIDATES);
}

export function appleMessagesHelperStatus(payload: unknown): AppleMessagesReadStatus | undefined {
  return parseHelperPayload(payload)?.status;
}

export function appleMessagesHelperFindings(payload: unknown): string[] {
  return nonEmptyFindings(parseHelperPayload(payload)?.findings);
}

export interface AppleMessagesMcpRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}
export interface AppleMessagesMcpCallbacks {
  status: () => Promise<unknown>;
  setup: (input: {
    watch: string;
    candidate?: string;
    alias?: string;
    approve?: boolean;
  }) => Promise<unknown>;
  readContext?: (input: { conversationRef: string; limit?: number }) => Promise<unknown>;
}
export interface AppleMessagesMcpStdioServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  callbacks: AppleMessagesMcpCallbacks;
}

export function appleMessagesMcpTools() {
  return [
    {
      name: 'messages_status',
      description: 'Report every configured Apple Messages watch and its checkpoint health.',
      inputSchema: emptySchema(),
    },
    {
      name: 'setup_messages_watch',
      description:
        'Resolve a bounded Messages candidate and, only with approve=true, add the selected watch.',
      inputSchema: setupSchema(),
    },
    {
      name: 'read_messages_context',
      description:
        'Read a bounded recent transcript for one already configured opaque conversation reference.',
      inputSchema: contextSchema(),
    },
  ];
}

export async function handleAppleMessagesMcpRequest(
  request: AppleMessagesMcpRequest,
  callbacks: AppleMessagesMcpCallbacks
): Promise<unknown> {
  if (request.method === 'initialize')
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'apple-messages', version: APPLE_MESSAGES_PROVIDER_VERSION },
    };
  if (request.method === 'notifications/initialized') return undefined;
  if (request.method === 'tools/list')
    return {
      tools: appleMessagesMcpTools().map((tool) => ({
        ...tool,
        annotations: {
          readOnlyHint: tool.name !== 'setup_messages_watch',
          destructiveHint: false,
          idempotentHint: tool.name !== 'setup_messages_watch',
          openWorldHint: true,
        },
      })),
    };
  if (
    request.method !== 'tools/call' ||
    !isRecord(request.params) ||
    typeof request.params.name !== 'string'
  )
    return { error: { code: -32601, message: 'Method not found' } };
  if (request.params.name === 'messages_status') return success(await callbacks.status());
  if (request.params.name === 'read_messages_context') {
    if (callbacks.readContext === undefined)
      return failure('invalid_input', 'read_messages_context is unavailable.');
    if (
      !isRecord(request.params.arguments) ||
      typeof request.params.arguments.conversationRef !== 'string'
    )
      return failure('invalid_input', 'read_messages_context requires conversationRef.');
    const limit = request.params.arguments.limit;
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20)
    )
      return failure('invalid_input', 'read_messages_context limit must be between 1 and 20.');
    return success(
      await callbacks.readContext({
        conversationRef: request.params.arguments.conversationRef,
        ...(typeof limit === 'number' ? { limit } : {}),
      })
    );
  }
  if (
    request.params.name !== 'setup_messages_watch' ||
    !isRecord(request.params.arguments) ||
    typeof request.params.arguments.watch !== 'string'
  )
    return failure('invalid_input', 'setup_messages_watch requires watch.');
  const input = request.params.arguments;
  const watch = input.watch;
  if (typeof watch !== 'string')
    return failure('invalid_input', 'setup_messages_watch requires watch.');
  return success(
    await callbacks.setup({
      watch,
      ...(typeof input.candidate === 'string' ? { candidate: input.candidate } : {}),
      ...(typeof input.alias === 'string' ? { alias: input.alias } : {}),
      ...(input.approve === true ? { approve: true } : {}),
    })
  );
}

export async function runAppleMessagesMcpStdioServer(
  options: AppleMessagesMcpStdioServerOptions
): Promise<void> {
  const reader = createInterface({ input: options.stdin ?? defaultStdin, crlfDelay: Infinity });
  const stdout = options.stdout ?? defaultStdout;
  for await (const line of reader) {
    if (line.trim().length === 0) continue;
    const request = parseRequest(line);
    if (request === undefined) {
      write(stdout, null, { error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    try {
      const response = await handleAppleMessagesMcpRequest(request, options.callbacks);
      if (response !== undefined) write(stdout, request.id ?? null, response);
    } catch {
      write(
        stdout,
        request.id ?? null,
        failure('tool_execution_failed', 'Apple Messages tool request could not be completed.')
      );
    }
  }
}

function appleMessagesReadResultFromSqliteRows(
  rows: AppleMessagesSqliteRow[],
  conversationLabel: string,
  readerLabel: string
): AppleMessagesReadResult {
  if (rows.length === 0)
    return {
      schemaVersion: 1,
      status: 'missing_config',
      messages: [],
      findings: [
        'No Apple Messages conversation matched the configured watched conversation label.',
      ],
    };
  try {
    const messages = rows
      .map((row) => normalizeSqliteRow(row, conversationLabel))
      .sort(
        (left, right) => left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id)
      );
    return {
      schemaVersion: 1,
      status: 'ready',
      messages,
      providerCursor: providerCursorForMessages(messages),
      findings: [],
    };
  } catch {
    return failedRead(`Apple Messages ${readerLabel} returned invalid message records.`);
  }
}

function normalizeSqliteRow(
  row: AppleMessagesSqliteRow,
  conversationLabel: string
): NormalizedAppleMessage {
  const chatGuid = requireNonEmptyValue(row.chatGuid, 'Apple Messages chat guid');
  return normalizeFixtureRow(
    {
      messageId: requireNonEmptyValue(String(row.messageId), 'Apple Messages message id'),
      chatGuid,
      isFromMe: row.isFromMe === true || row.isFromMe === 1 || row.isFromMe === '1',
      service: row.service ?? undefined,
      sentAt: appleMessageDateToIso(row.appleDate, 'Apple Messages message date'),
      handleValue: row.handleValue ?? undefined,
      text: row.text ?? undefined,
      attachmentCount: integerFromSqlite(row.attachmentCount),
      editedAt:
        row.dateEdited === undefined || row.dateEdited === null || Number(row.dateEdited) === 0
          ? undefined
          : appleMessageDateToIso(row.dateEdited, 'Apple Messages edit date'),
      deletedAt:
        row.dateDeleted === undefined || row.dateDeleted === null || Number(row.dateDeleted) === 0
          ? undefined
          : appleMessageDateToIso(row.dateDeleted, 'Apple Messages delete date'),
      hasReactions: false,
    },
    conversationLabel,
    `apple_messages_conversation_${hashText(chatGuid).slice(0, 32)}`
  );
}

function normalizeFixtureRow(
  row: AppleMessagesFixtureRow,
  conversationLabel: string,
  conversationRef: string
): NormalizedAppleMessage {
  assertNonEmptyString(row.messageId, 'Apple Messages fixture messageId');
  assertNonEmptyString(row.chatGuid, 'Apple Messages fixture chatGuid');
  const sentAt = isoTimestamp(row.sentAt, 'Apple Messages fixture sentAt');
  const text = row.text ?? '';
  return {
    source: 'apple_messages',
    id: `apple_message_${hashText(`${row.chatGuid}:${row.messageId}`).slice(0, 32)}`,
    conversation: { ref: conversationRef, label: conversationLabel },
    direction: row.isFromMe ? 'outbound' : 'inbound',
    service: normalizeService(row.service),
    sentAt,
    ...(row.handleValue === undefined
      ? {}
      : { senderRef: `apple_messages_sender_${hashText(row.handleValue).slice(0, 32)}` }),
    attachmentCount: row.attachmentCount ?? 0,
    content:
      text.length === 0 ? { mode: 'metadata_only' } : { mode: 'hash_only', hash: hashText(text) },
    ...(row.editedAt === undefined
      ? {}
      : { editedAt: isoTimestamp(row.editedAt, 'Apple Messages fixture editedAt') }),
    ...(row.deletedAt === undefined
      ? {}
      : { deletedAt: isoTimestamp(row.deletedAt, 'Apple Messages fixture deletedAt') }),
    unsupported: { reactions: row.hasReactions === true },
  };
}

function parseHelperPayload(payload: unknown): AppleMessagesHelperPayload | undefined {
  if (!isRecord(payload)) return undefined;
  return {
    status: validStatus(payload.status) ? payload.status : undefined,
    rows: Array.isArray(payload.rows) ? (payload.rows as AppleMessagesSqliteRow[]) : undefined,
    candidates: Array.isArray(payload.candidates) ? payload.candidates : undefined,
    findings: Array.isArray(payload.findings)
      ? payload.findings.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}
function validStatus(value: unknown): value is AppleMessagesReadStatus {
  return (
    value === 'ready' ||
    value === 'unsupported' ||
    value === 'missing_config' ||
    value === 'missing_permission' ||
    value === 'failed'
  );
}
function nonEmptyFindings(findings: string[] | undefined, fallback?: string): string[] {
  const value = findings?.filter((finding) => finding.trim().length > 0) ?? [];
  return value.length > 0 ? value : fallback === undefined ? [] : [fallback];
}
function failedRead(finding: string): AppleMessagesReadResult {
  return { schemaVersion: 1, status: 'failed', messages: [], findings: [finding] };
}
function failedWithStatus(
  status: AppleMessagesReadStatus,
  finding: string
): AppleMessagesReadResult {
  return { schemaVersion: 1, status, messages: [], findings: [finding] };
}
function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  );
}
function messagesSql(conversationLabel: string, maxMessages: number): string {
  const value = `'${conversationLabel.replace(/'/g, "''")}'`;
  return [
    `SELECT m.ROWID AS messageId, c.guid AS chatGuid, m.is_from_me AS isFromMe, m.service AS service, m.date AS appleDate, h.id AS handleValue, m.text AS text, COALESCE(m.cache_has_attachments, 0) AS attachmentCount, COALESCE(m.date_edited, 0) AS dateEdited, COALESCE(m.date_retracted, 0) AS dateDeleted`,
    'FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id',
    `WHERE c.display_name = ${value} OR c.chat_identifier = ${value} OR c.guid = ${value}`,
    'ORDER BY m.date DESC, m.ROWID DESC',
    `LIMIT ${Math.max(1, Math.min(maxMessages, 500))};`,
  ].join('\n');
}
function sqliteFailureStatus(stderr: string): AppleMessagesReadStatus {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('authorization denied') ||
    lower.includes('not authorized') ||
    lower.includes('permission denied') ||
    lower.includes('unable to open database')
  )
    return 'missing_permission';
  if (lower.includes('command not found') || lower.includes('no such file')) return 'unsupported';
  return 'failed';
}
function sqliteFailureFinding(status: AppleMessagesReadStatus): string {
  if (status === 'missing_permission')
    return 'Apple Messages chat.db is not readable; grant Full Disk Access to the configured Apple Messages host app.';
  if (status === 'unsupported')
    return 'Apple Messages live reads require the sqlite3 command on this Mac.';
  return 'Apple Messages chat.db reader failed before producing normalized records.';
}
function providerCursorForMessages(messages: NormalizedAppleMessage[]): string | undefined {
  return messages
    .map((message) => message.sentAt)
    .sort()
    .at(-1);
}
function appleMessageDateToIso(value: number | string | null, label: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid ${label}: ${String(value)}`);
  const unixMs =
    numeric > 10_000_000_000_000_000
      ? numeric / 1_000_000 + 978_307_200_000
      : numeric > 10_000_000_000
        ? numeric + 978_307_200_000
        : numeric * 1_000 + 978_307_200_000;
  return new Date(unixMs).toISOString();
}
function integerFromSqlite(value: number | string | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}
function normalizeService(service: string | undefined): string {
  return service === undefined || service.trim().length === 0 ? 'unknown' : service.trim();
}
function isoTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value)) || !value.includes('T'))
    throw new Error(`Invalid ${label} timestamp: ${value}`);
  return value;
}
function requireNonEmptyValue(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}
function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}
function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function emptySchema() {
  return { type: 'object', additionalProperties: false, properties: {} };
}
function setupSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['watch'],
    properties: {
      watch: { type: 'string', minLength: 2 },
      candidate: { type: 'string' },
      alias: { type: 'string' },
      approve: { type: 'boolean' },
    },
  };
}
function contextSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['conversationRef'],
    properties: {
      conversationRef: { type: 'string', minLength: 60 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  };
}
function success(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function failure(code: string, message: string) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function parseRequest(line: string): AppleMessagesMcpRequest | undefined {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function write(stdout: NodeJS.WritableStream, id: unknown, result: unknown) {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

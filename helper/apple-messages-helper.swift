import Contacts
import CryptoKit
import Foundation

let outputFilePath: String? = {
  let arguments = CommandLine.arguments
  guard let index = arguments.firstIndex(of: "--output-file"), index + 1 < arguments.count else {
    return nil
  }
  return arguments[index + 1]
}()

func printJson(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  if let outputFilePath {
    FileManager.default.createFile(atPath: outputFilePath, contents: data)
  } else {
    print(String(data: data, encoding: .utf8)!)
  }
}

func readRequest() -> [String: Any] {
  let arguments = CommandLine.arguments
  if let inputIndex = arguments.firstIndex(of: "--input-file"), inputIndex + 1 < arguments.count,
     let data = FileManager.default.contents(atPath: arguments[inputIndex + 1]),
     let object = try? JSONSerialization.jsonObject(with: data), let request = object as? [String: Any] {
    return request
  }
  let data = FileHandle.standardInput.readDataToEndOfFile()
  return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
}

func opaqueConversationRef(_ guid: String) -> String {
  let digest = SHA256.hash(data: Data(guid.utf8))
  return "apple_messages_conversation_" + digest.map { String(format: "%02x", $0) }.joined()
}

func databasePath(_ request: [String: Any]) -> String {
  return ((request["databasePath"] as? String) ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Messages/chat.db"))
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func sqlQuote(_ value: String) -> String { return "'\(value.replacingOccurrences(of: "'", with: "''"))'" }

func sqlite(_ path: String, _ sql: String) throws -> (stdout: String, stderr: String, status: Int32) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
  process.arguments = ["-readonly", "-json", path, sql]
  let stdout = Pipe(); let stderr = Pipe()
  process.standardOutput = stdout; process.standardError = stderr
  try process.run(); process.waitUntilExit()
  return (String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "", String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "", process.terminationStatus)
}

func failureStatus(_ stderr: String) -> String {
  let lower = stderr.lowercased()
  if lower.contains("authorization denied") || lower.contains("not authorized") || lower.contains("permission denied") || lower.contains("operation not permitted") || lower.contains("unable to open database") { return "missing_permission" }
  if lower.contains("command not found") || lower.contains("no such file") { return "unsupported" }
  return "failed"
}

func failureFinding(_ status: String) -> String {
  if status == "missing_permission" { return "Apple Messages chat.db is not readable; grant Full Disk Access to the configured Apple Messages host app." }
  if status == "unsupported" { return "Apple Messages live reads require the sqlite3 command on this Mac." }
  return "Apple Messages host helper failed before producing normalized records."
}

func result(_ kind: String, status: String, rows: [[String: Any]] = [], candidates: [[String: Any]] = [], findings: [String] = []) {
  var body: [String: Any] = ["schemaVersion": 1, "kind": kind, "status": status, "findings": findings]
  if kind.contains("candidates") { body["candidates"] = candidates } else { body["rows"] = rows }
  printJson(body)
}

func contactIdentifiers(_ query: String) -> [String] {
  guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return [] }
  let keys: [CNKeyDescriptor] = [CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor, CNContactNicknameKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor]
  let request = CNContactFetchRequest(keysToFetch: keys)
  var identifiers = Set<String>(); let needle = query.lowercased()
  try? CNContactStore().enumerateContacts(with: request) { contact, _ in
    let names = [contact.givenName, contact.familyName, contact.nickname, "\(contact.givenName) \(contact.familyName)"]
    guard names.contains(where: { $0.lowercased().contains(needle) }) else { return }
    contact.phoneNumbers.forEach { identifiers.insert($0.value.stringValue) }
    contact.emailAddresses.forEach { identifiers.insert(String($0.value)) }
  }
  return Array(identifiers).sorted().prefix(10).map { $0 }
}

struct PhoneLookup {
  let digits: String
  let allowsCountryPrefix: Bool
}

func phoneLookup(_ value: String) -> PhoneLookup? {
  let punctuation = CharacterSet(charactersIn: "+()- .")
  guard value.unicodeScalars.allSatisfy({ CharacterSet.decimalDigits.contains($0) || punctuation.contains($0) }) else { return nil }
  let digits = value.filter(\.isNumber)
  guard digits.count >= 10 else { return nil }
  return PhoneLookup(digits: digits, allowsCountryPrefix: !value.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("+"))
}

func normalizedIdentifierPredicate(_ expression: String, _ identifiers: [String]) -> String {
  let emails = Set(identifiers.map { $0.lowercased() }.filter { $0.contains("@") }).sorted()
  var phones: [String: Bool] = [:]
  identifiers.compactMap(phoneLookup).forEach { phone in
    phones[phone.digits] = (phones[phone.digits] ?? false) || phone.allowsCountryPrefix
  }
  var predicates = emails.map { "lower(\(expression)) = \(sqlQuote($0))" }
  if !phones.isEmpty {
    let normalized = "replace(replace(replace(replace(replace(replace(lower(\(expression)), '+', ''), '(', ''), ')', ''), '-', ''), ' ', ''), '.', '')"
    predicates.append("\(normalized) IN (\(phones.keys.sorted().map(sqlQuote).joined(separator: ", ")))")
    phones.filter(\.value).keys.sorted().forEach { digits in
      predicates.append("(length(\(normalized)) > \(digits.count) AND length(\(normalized)) <= \(digits.count + 3) AND substr(\(normalized), -\(digits.count)) = \(sqlQuote(digits)))")
    }
  }
  return predicates.joined(separator: " OR ")
}

func candidateMatchSelect(from: String, chatId: String, exact: String, contact: String, query: String) -> String {
  let conditions = [exact, contact, query].filter { !$0.isEmpty }
  var rank = "CASE WHEN (\(exact)) THEN 1"
  if !contact.isEmpty { rank += " WHEN (\(contact)) THEN 2" }
  rank += " ELSE 3 END"
  return "SELECT \(chatId) AS chatId, \(rank) AS matchRank FROM \(from) WHERE \(conditions.map { "(\($0))" }.joined(separator: " OR "))"
}

func candidatesSql(_ query: String, identifiers: [String], limit: Int) -> String {
  let value = sqlQuote(query)
  let lookupIdentifiers = [query] + identifiers
  let chatQuery = ["instr(lower(COALESCE(c.display_name, '')), lower(\(value))) > 0", "instr(lower(COALESCE(c.chat_identifier, '')), lower(\(value))) > 0", normalizedIdentifierPredicate("c.chat_identifier", lookupIdentifiers)].filter { !$0.isEmpty }.joined(separator: " OR ")
  let participantQuery = ["instr(lower(h.id), lower(\(value))) > 0", normalizedIdentifierPredicate("h.id", lookupIdentifiers)].filter { !$0.isEmpty }.joined(separator: " OR ")
  let messageQuery = ["instr(lower(mh.id), lower(\(value))) > 0", normalizedIdentifierPredicate("mh.id", lookupIdentifiers)].filter { !$0.isEmpty }.joined(separator: " OR ")
  let chatSelect = candidateMatchSelect(
    from: "chat c",
    chatId: "c.ROWID",
    exact: "lower(c.display_name) = lower(\(value)) OR lower(c.chat_identifier) = lower(\(value))",
    contact: normalizedIdentifierPredicate("c.chat_identifier", identifiers),
    query: chatQuery
  )
  let participantSelect = candidateMatchSelect(
    from: "chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id",
    chatId: "chj.chat_id",
    exact: "lower(h.id) = lower(\(value))",
    contact: normalizedIdentifierPredicate("h.id", identifiers),
    query: participantQuery
  )
  let messageSelect = candidateMatchSelect(
    from: "message m JOIN handle mh ON mh.ROWID = m.handle_id JOIN chat_message_join cmj ON cmj.message_id = m.ROWID",
    chatId: "cmj.chat_id",
    exact: "lower(mh.id) = lower(\(value))",
    contact: normalizedIdentifierPredicate("mh.id", identifiers),
    query: messageQuery
  )
  return "WITH matches AS (\(chatSelect) UNION ALL \(participantSelect) UNION ALL \(messageSelect)), ranked AS (SELECT chatId, MIN(matchRank) AS matchRank FROM matches GROUP BY chatId) SELECT c.guid AS chatGuid, CASE ranked.matchRank WHEN 1 THEN 'exact_label' WHEN 2 THEN 'contact_match' ELSE 'query_match' END AS matchKind FROM ranked JOIN chat c ON c.ROWID = ranked.chatId ORDER BY COALESCE((SELECT MAX(m.date) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id WHERE cmj.chat_id = c.ROWID), 0) DESC, c.ROWID DESC LIMIT \(min(max(limit, 1), 5));"
}

func shouldResolveContacts(_ query: String) -> Bool {
  return !query.contains("@") && query.contains(where: \.isLetter)
}

func readSql(_ conversation: String, _ maxMessages: Int) -> String {
  let value = sqlQuote(conversation)
  return "SELECT m.ROWID AS messageId, c.guid AS chatGuid, m.is_from_me AS isFromMe, m.service AS service, m.date AS appleDate, h.id AS handleValue, m.text AS text, COALESCE(m.cache_has_attachments, 0) AS attachmentCount, COALESCE(m.date_edited, 0) AS dateEdited, COALESCE(m.date_retracted, 0) AS dateDeleted FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE c.display_name = \(value) OR c.chat_identifier = \(value) OR c.guid = \(value) ORDER BY m.date DESC, m.ROWID DESC LIMIT \(min(max(maxMessages, 1), 500));"
}

let command = CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("--") }) ?? "messages-read"
let request = readRequest(); let path = databasePath(request)
let candidateKind = "apple-messages-helper-candidates-result"; let readKind = "apple-messages-helper-read-result"
guard !path.isEmpty && FileManager.default.fileExists(atPath: path) else { result(command == "messages-read" ? readKind : candidateKind, status: "failed", findings: ["Apple Messages chat.db was not found at the expected local path."]); exit(2) }
guard FileManager.default.isReadableFile(atPath: path) else { result(command == "messages-read" ? readKind : candidateKind, status: "missing_permission", findings: ["Apple Messages chat.db is not readable; grant Full Disk Access to the configured Apple Messages host app."]); exit(3) }

do {
  if command == "messages-candidates" {
    let query = ((request["query"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2 else { result(candidateKind, status: "failed", findings: ["Apple Messages candidate lookup requires a query of at least two characters."]); exit(64) }
    let identifiers = shouldResolveContacts(query) ? contactIdentifiers(query) : []
    let response = try sqlite(path, candidatesSql(query, identifiers: identifiers, limit: (request["limit"] as? Int) ?? 5))
    guard response.status == 0 else { let status = failureStatus(response.stderr); result(candidateKind, status: status, findings: [failureFinding(status)]); exit(status == "missing_permission" ? 3 : 2) }
    let rows = ((try? JSONSerialization.jsonObject(with: Data(response.stdout.utf8))) as? [[String: Any]]) ?? []
    let candidates = rows.enumerated().compactMap { index, row -> [String: Any]? in guard let guid = row["chatGuid"] as? String, let kind = row["matchKind"] as? String else { return nil }; return ["candidateRef": opaqueConversationRef(guid), "label": "Conversation \(index + 1)", "matchKind": kind == "exact_label" ? "exact_label" : kind == "contact_match" ? "contact_match" : "query_match"] }
    result(candidateKind, status: "ready", candidates: candidates)
  } else if command == "messages-validate" {
    let ref = (request["conversationRef"] as? String) ?? ""
    let response = try sqlite(path, "SELECT c.guid AS chatGuid FROM chat c ORDER BY c.ROWID DESC;")
    guard response.status == 0 else { let status = failureStatus(response.stderr); result(candidateKind, status: status, findings: [failureFinding(status)]); exit(status == "missing_permission" ? 3 : 2) }
    let rows = ((try? JSONSerialization.jsonObject(with: Data(response.stdout.utf8))) as? [[String: Any]]) ?? []
    let found = rows.contains { ($0["chatGuid"] as? String).map(opaqueConversationRef) == ref }
    result(candidateKind, status: found ? "ready" : "missing_config", findings: found ? [] : ["The configured Apple Messages conversation is no longer available."])
  } else {
    var conversation = ((request["conversationLabel"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let ref = ((request["conversationRef"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !ref.isEmpty {
      let response = try sqlite(path, "SELECT c.guid AS chatGuid FROM chat c ORDER BY c.ROWID DESC;")
      guard response.status == 0 else {
        let status = failureStatus(response.stderr)
        result(readKind, status: status, findings: [failureFinding(status)])
        exit(status == "missing_permission" ? 3 : 2)
      }
      let rows = ((try? JSONSerialization.jsonObject(with: Data(response.stdout.utf8))) as? [[String: Any]]) ?? []
      guard let guid = rows.first(where: { ($0["chatGuid"] as? String).map(opaqueConversationRef) == ref })?["chatGuid"] as? String else {
        result(readKind, status: "missing_config", findings: ["The configured Apple Messages conversation is no longer available."])
        exit(2)
      }
      conversation = guid
    }
    guard !conversation.isEmpty else { result(readKind, status: "missing_config", findings: ["Apple Messages host helper requires a watched conversation label."]); exit(64) }
    let response = try sqlite(path, readSql(conversation, (request["maxMessages"] as? Int) ?? 50))
    guard response.status == 0 else { let status = failureStatus(response.stderr); result(readKind, status: status, findings: [failureFinding(status)]); exit(status == "missing_permission" ? 3 : 2) }
    let rows = response.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : (((try? JSONSerialization.jsonObject(with: Data(response.stdout.utf8))) as? [[String: Any]]) ?? [])
    result(readKind, status: "ready", rows: rows)
  }
} catch { result(command == "messages-read" ? readKind : candidateKind, status: "unsupported", findings: ["Apple Messages live reads require the sqlite3 command on this Mac."]); exit(2) }

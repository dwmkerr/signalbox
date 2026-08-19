// Exchange fields are decoded leniently because older hubs may omit optional
// values such as `cropped`.
struct Exchange: Decodable, Equatable {
    let prompt: String?
    let reply: String?
    let ts: String
    let cropped: Bool
    let seq: Int

    // The hub omits cropped when false (optional fields leave the JSON when
    // empty), so a synthesized decode would throw on nearly every exchange
    // and silently blank the preview via the []-on-failure fallback.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prompt = try? c.decodeIfPresent(String.self, forKey: .prompt)
        reply = try? c.decodeIfPresent(String.self, forKey: .reply)
        ts = (try? c.decode(String.self, forKey: .ts)) ?? ""
        cropped = (try? c.decodeIfPresent(Bool.self, forKey: .cropped)) ?? false
        seq = (try? c.decodeIfPresent(Int.self, forKey: .seq)) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case prompt, reply, ts, cropped, seq
    }

    init(prompt: String?, reply: String?, ts: String, cropped: Bool, seq: Int) {
        self.prompt = prompt
        self.reply = reply
        self.ts = ts
        self.cropped = cropped
        self.seq = seq
    }
}

struct ExchangesDoc: Decodable {
    let sessionKey: String
    let exchanges: [Exchange]
    let nextBefore: Int?

    enum CodingKeys: String, CodingKey {
        case sessionKey = "session_key"
        case exchanges
        case nextBefore = "next_before"
    }
}

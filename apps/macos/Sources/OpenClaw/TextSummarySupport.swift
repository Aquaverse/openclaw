import Foundation

enum TextSummarySupport {
    static func summarizeLastLine(_ text: String, maxLength: Int = 200) -> String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        // The openclaw CLI's own failure formatter (src/cli/failure-output.ts
        // formatCliFailureLines) always ends a real error with a fixed,
        // generic trailer -- "[openclaw] Debug: set OPENCLAW_DEBUG=1 …",
        // "[openclaw] Try: openclaw doctor", "[openclaw] Help: openclaw
        // --help" -- with the actually useful "[openclaw] Reason: …" line
        // above them. Surfacing the trailer (as plain last-line summarizing
        // did) hides the real reason behind a useless "run --help" message,
        // observed in testing as a completely uninformative
        // "[openclaw] Help: openclaw --help" failure reason for what was
        // otherwise a diagnosable CLI error. Prefer that Reason line first.
        if let reasonLine = lines.last(where: { $0.hasPrefix("[openclaw] Reason:") }) {
            let normalized = reasonLine
                .replacingOccurrences(of: "[openclaw] Reason:", with: "")
                .trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            if !normalized.isEmpty {
                return normalized.count > maxLength
                    ? String(normalized.prefix(maxLength - 1)) + "…"
                    : normalized
            }
        }
        // Node fatal errors end with a bare "Node.js vX.Y.Z" banner. Surfacing
        // that line hides the actual failure ("Error: Cannot find module …"),
        // so drop the banner and prefer the last real error line above it.
        var candidates = lines[...]
        var droppedNodeBanner = false
        while let last = candidates.last, Self.isNodeVersionBanner(last) {
            candidates = candidates.dropLast()
            droppedNodeBanner = true
        }
        while let last = candidates.last, Self.isOpenclawCLITrailerLine(last) {
            candidates = candidates.dropLast()
        }
        var chosen = candidates.last ?? lines[lines.count - 1]
        if droppedNodeBanner, let errorLine = candidates.suffix(40).last(where: self.isErrorLine) {
            chosen = errorLine
        }
        let normalized = chosen.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if normalized.count > maxLength {
            return String(normalized.prefix(maxLength - 1)) + "…"
        }
        return normalized
    }

    private static func isNodeVersionBanner(_ line: String) -> Bool {
        line.range(of: #"^Node\.js v\d"#, options: .regularExpression) != nil
    }

    // The fixed trailer lines formatCliFailureLines() always appends after
    // the (possibly absent) Reason line -- see the comment above. None of
    // these carry any failure-specific detail, so they are never worth
    // surfacing as a one-line summary.
    private static func isOpenclawCLITrailerLine(_ line: String) -> Bool {
        line.hasPrefix("[openclaw] Debug:")
            || line.hasPrefix("[openclaw] Try:")
            || line.hasPrefix("[openclaw] Help:")
            || line.hasPrefix("[openclaw] Stack:")
    }

    private static func isErrorLine(_ line: String) -> Bool {
        line.range(of: #"^\w*Error(\b|:)"#, options: .regularExpression) != nil
    }
}

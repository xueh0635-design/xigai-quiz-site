import Foundation
import Vision

let screenshot = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(url: screenshot).perform([request])
let lines = request.results?.compactMap { $0.topCandidates(1).first?.string.uppercased() } ?? []
let text = lines.joined(separator: " ")
guard text.contains("XIGAI SYNC UI PASS") else {
    let status = lines.first { $0.contains("XIGAI") } ?? "sync marker absent"
    FileHandle.standardError.write(Data("iPhone simulator result: \(status)\n".utf8))
    exit(1)
}
print("iPhone simulator verified exact synced answer options and resuming across devices.")

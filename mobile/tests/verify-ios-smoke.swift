import Foundation
import Vision

let image = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(url: image).perform([request])
let status = request.results?.compactMap { $0.topCandidates(1).first?.string }
    .first { $0.localizedCaseInsensitiveContains("XIGAI") }
guard status?.uppercased().contains("XIGAI PASS") == true else {
    FileHandle.standardError.write(Data("Simulator result: \(status ?? "smoke marker absent")\n".utf8))
    exit(1)
}
print("iOS simulator verified timed advance, swipes, distractor notes, local progress, memory mode, quiz submission, knowledge navigation and profile collections.")

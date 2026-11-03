// macOS Vision 한국어 OCR. 사용법: vision-ocr <이미지>...
// 출력: [{"file":..., "width":..., "height":..., "lines":[{"text","x","y","w","h","conf"}]}]
// 좌표는 이미지 왼쪽 위 기준 픽셀.
import Foundation
import Vision
import AppKit

struct Line: Codable { let text: String; let x: Int; let y: Int; let w: Int; let h: Int; let conf: Float }
struct Page: Codable { let file: String; let width: Int; let height: Int; let lines: [Line]; let error: String? }

func recognize(_ file: String) -> Page {
    guard let img = NSImage(contentsOfFile: file),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return Page(file: file, width: 0, height: 0, lines: [], error: "image_unreadable")
    }
    let W = cg.width, H = cg.height
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["ko-KR", "en-US"]
    if #available(macOS 13.0, *) {
        req.revision = VNRecognizeTextRequestRevision3
        req.automaticallyDetectsLanguage = false
    }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch {
        return Page(file: file, width: W, height: H, lines: [], error: "vision_failed: \(error.localizedDescription)")
    }
    var lines: [Line] = []
    for obs in req.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(Line(text: top.string,
                          x: Int(b.minX * CGFloat(W)), y: Int((1 - b.maxY) * CGFloat(H)),
                          w: Int(b.width * CGFloat(W)), h: Int(b.height * CGFloat(H)),
                          conf: top.confidence))
    }
    return Page(file: file, width: W, height: H, lines: lines, error: nil)
}

let files = Array(CommandLine.arguments.dropFirst())
if files.isEmpty {
    FileHandle.standardError.write("usage: vision-ocr <image>...\n".data(using: .utf8)!)
    exit(2)
}
if #available(macOS 12.0, *) {
    let langs = (try? VNRecognizeTextRequest().supportedRecognitionLanguages()) ?? []
    if !langs.contains("ko-KR") {
        FileHandle.standardError.write("korean_unsupported\n".data(using: .utf8)!)
        exit(3)
    }
} else {
    // 한국어 인식은 macOS 13(Vision revision 3)부터 지원
    FileHandle.standardError.write("korean_unsupported\n".data(using: .utf8)!)
    exit(3)
}
let pages = files.map(recognize)
let enc = JSONEncoder()
FileHandle.standardOutput.write(try! enc.encode(pages))

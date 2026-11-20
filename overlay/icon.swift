// Draws Gruppetto HUD's icon: swift icon.swift out.iconset (build.sh turns it into AppIcon.icns).
// A dark see-through panel like the HUD itself, with the orange bolt of the power figure.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024
  // the macOS icon grid: an 824 pt rounded square in a 1024 canvas
  let body = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
  let shape = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)
  NSGradient(starting: NSColor(srgbRed: 0.17, green: 0.21, blue: 0.29, alpha: 1),
             ending: NSColor(srgbRed: 0.07, green: 0.09, blue: 0.13, alpha: 1))!.draw(in: shape, angle: -90)
  // three rows of the panel: power, heart rate, cadence, each with its colour bar on the left
  let rows: [(NSColor, CGFloat)] = [
    (NSColor(srgbRed: 0.98, green: 0.45, blue: 0.09, alpha: 1), 0.0),
    (NSColor(srgbRed: 0.94, green: 0.27, blue: 0.27, alpha: 1), 1.0),
    (NSColor(srgbRed: 0.13, green: 0.83, blue: 0.93, alpha: 1), 2.0),
  ]
  for (color, i) in rows {
    let y = (640 - i * 190) * s
    let row = NSBezierPath(roundedRect: NSRect(x: 190 * s, y: y, width: 644 * s, height: 150 * s), xRadius: 34 * s, yRadius: 34 * s)
    NSColor(white: 1, alpha: 0.07).setFill(); row.fill()
    color.setFill()
    NSBezierPath(roundedRect: NSRect(x: 190 * s, y: y, width: 26 * s, height: 150 * s), xRadius: 13 * s, yRadius: 13 * s).fill()
    // the figure: a bar that reads as a number from afar
    NSColor(white: 1, alpha: 0.85).setFill()
    NSBezierPath(roundedRect: NSRect(x: (i == 0 ? 400 : 270) * s, y: y + 50 * s, width: (i == 0 ? 330 : i == 1 ? 300 : 240) * s, height: 50 * s), xRadius: 25 * s, yRadius: 25 * s).fill()
  }
  // the power row carries the bolt
  let bolt = NSBezierPath()
  let p = { (x: CGFloat, y: CGFloat) in NSPoint(x: x * s, y: y * s) }
  bolt.move(to: p(345, 790)); bolt.line(to: p(255, 705)); bolt.line(to: p(312, 705))
  bolt.line(to: p(282, 640)); bolt.line(to: p(375, 730)); bolt.line(to: p(318, 730)); bolt.close()
  NSColor(srgbRed: 0.98, green: 0.45, blue: 0.09, alpha: 1).setFill(); bolt.fill()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
  try! draw(size).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size).png"))
  try! draw(size * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size)@2x.png"))
}

// Gruppetto HUD: the ride's numbers in a see-through panel over everything on a Mac — a film, the football, a
// full-screen video. Gruppetto (the web page) sends them over a WebSocket on this computer (127.0.0.1:47629);
// nothing leaves the Mac. The panel shows while a ride sends numbers and hides a few seconds after it stops.
//
// Build: overlay/build.sh (swiftc, no Xcode project). The menu bar icon: click-through, opacity, size, quit.

import AppKit
import Network
import SwiftUI

// MARK: - The numbers

/// One second of the ride, as Gruppetto's mini window gets it (js/app.js pipState).
struct RideState: Decodable {
    var power: Int = 0
    var zone: String = ""
    var zoneColor: String = "#8a94a6"
    var powerColor: String? = nil
    var powerCls: String? = nil
    var wkg: String = ""
    var hr: String = "—"
    var hrAvg: String = ""
    var cad: String = "0"
    var cadCls: String? = nil
    var cadAvg: String = ""
    var cadTarget: String = ""
    var workout: Bool = false
    var target: String = ""
    var left: String = ""
    var next: String = ""
    var stepF: Double? = nil
    var stepLeft: Double? = nil
    var time: String = "0:00"
    var speed: String = "0.0"
    var dist: String = "0.00"
    var wbalF: Double = 1
    var wbalKj: String? = nil
    var wbalLevel: String = "ok"
    var paused: Bool = false
    var labels: [String: String]? = nil

    func label(_ key: String, _ fallback: String) -> String { labels?[key] ?? fallback }

    enum CodingKeys: String, CodingKey {
        case power, zone, zoneColor, powerColor, powerCls, wkg, hr, hrAvg, cad, cadCls, cadAvg, cadTarget, workout, target, left, next
        case stepF, stepLeft, time, speed, dist, wbalF, wbalKj, wbalLevel, paused, labels
    }

    init() {}
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        func str(_ k: CodingKeys) -> String? {
            if let s = try? c.decode(String.self, forKey: k) { return s }
            if let n = try? c.decode(Double.self, forKey: k) { return n == n.rounded() ? String(Int(n)) : String(n) }
            return nil
        }
        power = (try? c.decode(Int.self, forKey: .power)) ?? Int(str(.power) ?? "0") ?? 0
        zone = str(.zone) ?? ""
        zoneColor = str(.zoneColor) ?? "#8a94a6"
        powerColor = str(.powerColor)
        powerCls = str(.powerCls)
        wkg = str(.wkg) ?? ""
        hr = str(.hr) ?? "—"
        hrAvg = str(.hrAvg) ?? ""
        cad = str(.cad) ?? "0"
        cadCls = str(.cadCls)
        cadAvg = str(.cadAvg) ?? ""
        cadTarget = str(.cadTarget) ?? ""
        workout = (try? c.decode(Bool.self, forKey: .workout)) ?? false
        target = str(.target) ?? ""
        left = str(.left) ?? ""
        next = str(.next) ?? ""
        stepF = try? c.decode(Double.self, forKey: .stepF)
        stepLeft = try? c.decode(Double.self, forKey: .stepLeft)
        time = str(.time) ?? "0:00"
        speed = str(.speed) ?? "0.0"
        dist = str(.dist) ?? "0.00"
        wbalF = (try? c.decode(Double.self, forKey: .wbalF)) ?? 1
        wbalKj = str(.wbalKj)
        wbalLevel = str(.wbalLevel) ?? "ok"
        paused = (try? c.decode(Bool.self, forKey: .paused)) ?? false
        labels = try? c.decode([String: String].self, forKey: .labels)
    }
}

final class Model: ObservableObject {
    @Published var state = RideState()
    @Published var live = false
    @Published var opacity: Double = UserDefaults.standard.object(forKey: "opacity") as? Double ?? 0.82
    var lastAt = Date.distantPast
}

// MARK: - Colours

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        if s.count == 6 {
            self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
        } else {
            self.init(white: 0.6)
        }
    }
}

let muted = Color(hex: "#a9b6c8")
func classColor(_ cls: String?) -> Color? {
    switch cls ?? "" {
    case let c where c.contains("c-ok"): return Color(hex: "#4ade80")
    case let c where c.contains("c-warn"): return Color(hex: "#fbbf24")
    case let c where c.contains("c-bad"): return Color(hex: "#f87171")
    default: return nil
    }
}

// MARK: - The panel

struct Number: View {
    let name: String
    let nameColor: Color
    let value: String
    var unit: String = ""
    let sub: String
    var valueColor: Color = .white
    var tag: (String, Color)? = nil
    let size: CGFloat
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text(name.uppercased()).font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundColor(nameColor)
                if let t = tag, !t.0.isEmpty {
                    Text(t.0).font(.system(size: 10, weight: .heavy)).foregroundColor(Color(hex: "#0f1420"))
                        .padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 3).fill(t.1))
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(.system(size: size, weight: .heavy, design: .rounded)).monospacedDigit().foregroundColor(valueColor)
                    .lineLimit(1).minimumScaleFactor(0.5)
                if !unit.isEmpty { Text(unit).font(.system(size: size * 0.3, weight: .bold)).foregroundColor(muted) }
            }
            Text(sub).font(.system(size: 11, weight: .medium)).foregroundColor(muted).lineLimit(1)
        }
    }
}

struct Cell: View {
    let name: String
    let value: String
    var unit: String = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(name.uppercased()).font(.system(size: 9.5, weight: .semibold)).tracking(0.5).foregroundColor(muted)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(.system(size: 19, weight: .heavy, design: .rounded)).monospacedDigit().foregroundColor(.white)
                if !unit.isEmpty { Text(unit).font(.system(size: 10, weight: .semibold)).foregroundColor(muted) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Panel: View {
    @ObservedObject var m: Model
    var body: some View {
        let s = m.state
        let zc = s.power > 0 ? Color(hex: s.zoneColor) : Color(hex: "#8a94a6")
        let pc = classColor(s.powerCls) ?? (s.powerColor.map { Color(hex: $0) } ?? .white)
        let wbalC: Color = s.wbalLevel == "ok" ? Color(hex: "#a78bfa") : s.wbalLevel == "mid" ? Color(hex: "#fbbf24") : s.wbalLevel == "low" ? Color(hex: "#fb923c") : Color(hex: "#f87171")
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom, spacing: 22) {
                Number(name: s.label("power", "Power"), nameColor: zc, value: String(s.power), unit: s.label("W", "W"), sub: s.wkg, valueColor: pc, tag: (s.zone, Color(hex: s.zoneColor)), size: 64)
                Number(name: s.label("hr", "HR"), nameColor: Color(hex: "#ff6b78"), value: s.hr, sub: s.hrAvg, size: 40)
                Number(name: s.label("cad", "Cadence"), nameColor: Color(hex: "#4fdcf2"), value: s.cad, sub: s.cadTarget.isEmpty ? s.cadAvg : s.cadTarget, valueColor: classColor(s.cadCls) ?? .white, size: 40)
            }
            if s.workout {
                VStack(spacing: 0) {
                    HStack(spacing: 18) {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(s.label("target", "Target").uppercased()).font(.system(size: 9.5, weight: .semibold)).foregroundColor(muted)
                            Text(s.target).font(.system(size: 18, weight: .heavy, design: .rounded)).foregroundColor(classColor(s.powerCls) ?? .white)
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(s.label("interval", "Interval").uppercased()).font(.system(size: 9.5, weight: .semibold)).foregroundColor(muted)
                            Text(s.left).font(.system(size: 18, weight: .heavy, design: .rounded)).monospacedDigit().foregroundColor(.white)
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(s.label("next", "Next").uppercased()).font(.system(size: 9.5, weight: .semibold)).foregroundColor(muted)
                            Text(s.next).font(.system(size: 18, weight: .heavy, design: .rounded)).foregroundColor(.white)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    GeometryReader { g in
                        Rectangle().fill(zc).frame(width: g.size.width * CGFloat(max(0, min(1, s.stepF ?? 0))), height: 3)
                    }.frame(height: 3)
                }
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke((s.stepLeft ?? 99) <= 10 ? Color(hex: "#fbbf24") : Color.clear, lineWidth: 1.5))
            }
            HStack(alignment: .bottom, spacing: 8) {
                Cell(name: s.label("time", "Time"), value: s.time)
                Cell(name: s.label("speed", "Speed"), value: s.speed, unit: s.label("kmh", "km/h"))
                Cell(name: s.label("distance", "Distance"), value: s.dist, unit: s.label("km", "km"))
                VStack(alignment: .leading, spacing: 3) {
                    Cell(name: "W′bal", value: s.wbalKj ?? "", unit: s.label("kj", "kJ"))
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.14))
                            Capsule().fill(wbalC).frame(width: g.size.width * CGFloat(max(0, min(1, s.wbalF))))
                        }
                    }.frame(height: 4)
                }
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .frame(width: 400, alignment: .leading)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(hex: "#0c111b").opacity(m.opacity))
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(RadialGradient(colors: [zc.opacity(0.28 * m.opacity), .clear], center: .bottomLeading, startRadius: 0, endRadius: 300))
                RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.white.opacity(0.12), lineWidth: 1)
            }
        )
        .overlay(
            Group {
                if s.paused {
                    RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.black.opacity(0.55))
                        .overlay(Text(s.label("paused", "PAUSED")).font(.system(size: 30, weight: .heavy)).tracking(4).foregroundColor(.white))
                }
            }
        )
        .padding(12) // room for the shadow
        .shadow(color: .black.opacity(0.45), radius: 14, y: 6)
        .fixedSize()
    }
}

// MARK: - The window: borderless, see-through, over everything, dragged by its body

final class HUDPanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 430, height: 220), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .screenSaver // over full-screen video too
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        contentView = content
    }
    override var canBecomeKey: Bool { false }
}

// MARK: - The WebSocket server on 127.0.0.1

final class Server {
    let port: NWEndpoint.Port = 47629
    var listener: NWListener?
    let onState: (RideState) -> Void
    init(onState: @escaping (RideState) -> Void) { self.onState = onState }

    func start() {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port) // this Mac only
        params.allowLocalEndpointReuse = true
        do {
            let l = try NWListener(using: params)
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.start(queue: .main)
            listener = l
        } catch {
            NSLog("Gruppetto HUD: cannot listen on \(port): \(error)")
        }
    }

    func accept(_ c: NWConnection) {
        c.start(queue: .main)
        receive(c)
    }

    func receive(_ c: NWConnection) {
        c.receiveMessage { [weak self] data, _, _, error in
            if let data, let s = try? JSONDecoder().decode(RideState.self, from: data) { self?.onState(s) }
            if error == nil { self?.receive(c) } else { c.cancel() }
        }
    }
}

// MARK: - The app

final class App: NSObject, NSApplicationDelegate {
    let model = Model()
    var panel: HUDPanel!
    var status: NSStatusItem!
    var server: Server!
    var clickThrough = UserDefaults.standard.bool(forKey: "clickThrough")

    func applicationDidFinishLaunching(_ n: Notification) {
        let host = NSHostingView(rootView: Panel(m: model))
        host.frame = NSRect(x: 0, y: 0, width: 430, height: 220)
        panel = HUDPanel(content: host)
        panel.ignoresMouseEvents = clickThrough
        placePanel()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.title = "🚴"
        rebuildMenu()
        server = Server { [weak self] s in self?.got(s) }
        server.start()
        // shown while a ride sends numbers, hidden 8 s after it stops
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            let live = Date().timeIntervalSince(self.model.lastAt) < 8 && !self.hiddenUntilQuiet
            if live != self.model.live { self.model.live = live; live ? self.panel.orderFrontRegardless() : self.panel.orderOut(nil) }
        }
    }

    func got(_ s: RideState) {
        model.state = s
        let quiet = Date().timeIntervalSince(model.lastAt) > 30
        model.lastAt = Date()
        if hiddenUntilQuiet { if quiet { hiddenUntilQuiet = false } else { return } }
        if !model.live { model.live = true; panel.orderFrontRegardless() }
        if let host = panel.contentView { panel.setContentSize(host.fittingSize) }
    }

    func placePanel() {
        if let saved = UserDefaults.standard.string(forKey: "origin") {
            panel.setFrameOrigin(NSPointFromString(saved))
        } else if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - 450, y: screen.minY + 40))
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self] _ in
            guard let self else { return }
            UserDefaults.standard.set(NSStringFromPoint(self.panel.frame.origin), forKey: "origin")
        }
    }

    var liveItem: NSMenuItem?
    func rebuildMenu() {
        let menu = NSMenu()
        let live = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        live.isEnabled = false
        liveItem = live
        updateLiveItem()
        menu.addItem(live)
        menu.addItem(.separator())
        let ct = NSMenuItem(title: "Click through the panel", action: #selector(toggleClickThrough), keyEquivalent: "")
        ct.state = clickThrough ? .on : .off
        ct.target = self
        menu.addItem(ct)
        let op = NSMenuItem(title: "Background", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (name, v) in [("Solid", 0.95), ("See-through", 0.82), ("Light", 0.6), ("Barely there", 0.35)] {
            let i = NSMenuItem(title: name, action: #selector(setOpacity(_:)), keyEquivalent: "")
            i.representedObject = v
            i.state = abs(model.opacity - v) < 0.01 ? .on : .off
            i.target = self
            sub.addItem(i)
        }
        op.submenu = sub
        menu.addItem(op)
        let hide = NSMenuItem(title: "Hide until the next ride", action: #selector(hideNow), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)
        let show = NSMenuItem(title: "Show it now (to place it)", action: #selector(showNow), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Gruppetto HUD", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.delegate = self
        status.menu = menu
    }

    @objc func toggleClickThrough() {
        clickThrough.toggle()
        UserDefaults.standard.set(clickThrough, forKey: "clickThrough")
        panel.ignoresMouseEvents = clickThrough
        rebuildMenu()
    }

    @objc func setOpacity(_ sender: NSMenuItem) {
        model.opacity = sender.representedObject as? Double ?? 0.82
        UserDefaults.standard.set(model.opacity, forKey: "opacity")
        rebuildMenu()
    }

    var hiddenUntilQuiet = false
    @objc func hideNow() {
        hiddenUntilQuiet = true // back with the next ride: once numbers have stopped for a while and come again
        model.live = false
        panel.orderOut(nil)
    }

    @objc func showNow() {
        hiddenUntilQuiet = false
        model.lastAt = Date()
        model.live = true
        panel.ignoresMouseEvents = false // to drag it into place; click-through comes back with the next ride's numbers
        panel.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self else { return }
            self.panel.ignoresMouseEvents = self.clickThrough
        }
    }
}

extension App: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) { updateLiveItem() }
}
extension App {
    func updateLiveItem() { liveItem?.title = model.live ? "Riding: showing the numbers" : "Waiting for a ride in Gruppetto…" }
}

@MainActor func snapshot(to path: String, workout: Bool) {
    let m = Model()
    var st = RideState()
    st.power = workout ? 232 : 150; st.zone = workout ? "Z4" : "Z2"; st.zoneColor = workout ? "#eab308" : "#3b82f6"
    st.powerColor = st.zoneColor; st.powerCls = workout ? "c-ok" : ""; st.wkg = workout ? "3.1 W/kg · 95% FTP" : "2.0 W/kg · 62% FTP"
    st.hr = "128"; st.hrAvg = "avg 104"; st.cad = "88"; st.cadAvg = "avg 90"
    st.workout = workout; st.target = "235"; st.left = "1:48"; st.next = "160 W"; st.stepF = 0.6; st.stepLeft = 40
    st.time = "24:37"; st.speed = "31.4"; st.dist = "12.80"; st.wbalF = 0.72; st.wbalKj = "14.4"
    m.state = st
    let r = ImageRenderer(content: ZStack { LinearGradient(colors: [Color(hex: "#3a7d3a"), Color(hex: "#1f4d2a")], startPoint: .top, endPoint: .bottom); Panel(m: m) })
    r.scale = 2
    if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: path))
    }
}

@main
enum Main {
    static let delegate = App()
    static func main() {
        // --snapshot <file.png> [workout]: the panel with sample numbers drawn to a PNG (to check the look)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            MainActor.assumeIsolated { snapshot(to: args[i + 1], workout: args.contains("workout")) }
            return
        }
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory) // a menu bar app: no Dock icon
        app.run()
    }
}

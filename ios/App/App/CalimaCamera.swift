import AVFoundation
import AVKit
import Capacitor
import CoreImage
import CoreMotion
import MetalKit
import Photos
import UIKit

// Calimas Kamera (Workshop 9.10.2026, kamera-workshop-2026-10-09/): der Sucher liegt hinter der Webansicht, und der
// Look liegt als 3D-LUT (CIColorCubeWithColorSpace) live auf dem Bild. Der Web-Teil rechnet den LUT (buildLut, wie in
// der Vorschau) und zeichnet die Bedienung; hier laufen nur Kamera, Farbwürfel und Auslösen. Das Foto kommt unbearbeitet
// und mit Aufnahmedaten als JPEG-Datei zurück; den Look rechnet das Fotostudio ein wie bei jedem anderen Foto.
// Apples Bildverarbeitung bleibt an (.balanced): kein „Process Zero“, keine weicheren Bilder als Apples Kamera.

@objc(CalimaCameraPlugin)
public class CalimaCameraPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalimaCameraPlugin"
    public let jsName = "CalimaCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOriginal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExposure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGrain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDials", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMagnify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLevel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "measureWhite", returnType: CAPPluginReturnPromise),
    ]

    private let camera = CalimaCamera()
    private var wasOpaque = true

    public override func load() {
        // Ereignisse der Erkenner kommen als `event` mit `name` und `data` auf der Seite an
        camera.onEvent = { [weak self] name, data in
            // NaN oder unendlich (etwa die Messung, solange die Belichtung umschaltet) kann JSON nicht: solche Werte fallen weg,
            // sonst kommt das ganze Ereignis leer an
            let clean = data.filter { !(($0.value as? Double).map { !$0.isFinite } ?? false) }
            DispatchQueue.main.async { self?.notifyListeners("event", data: ["name": name, "data": clean]) }
        }
        // Quick Action, während die Seite schon läuft: melden, dass etwas wartet; abgeholt wird mit `launch`
        _ = NotificationCenter.default.addObserver(forName: CalimaLaunch.waiting, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("event", data: ["name": "launch", "data": [:]])
        }
    }

    /// Die wartende Aktion vom App-Symbol abholen (einmal): `action` ist „kamera“ oder fehlt
    @objc func launch(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let action = CalimaLaunch.take() { call.resolve(["action": action]) } else { call.resolve() }
        }
    }
    private var wasBackground: UIColor?

    private func frame(from call: CAPPluginCall) -> CGRect? {
        guard let f = call.getObject("frame"),
              let x = f["x"] as? Double, let y = f["y"] as? Double,
              let w = f["w"] as? Double, let h = f["h"] as? Double, w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    @objc func start(_ call: CAPPluginCall) {
        let frame = self.frame(from: call) ?? .zero
        let lut = call.getString("lut")
        let n = call.getInt("n") ?? 33
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Kamera nicht erlaubt", "denied")
                return
            }
            DispatchQueue.main.async {
                guard let webView = self.webView, let host = webView.superview else {
                    call.reject("Keine Webansicht", "noview")
                    return
                }
                // Die Webseite wird durchsichtig, der Sucher liegt dahinter; die Seite selbst malt um den Sucher herum
                self.wasOpaque = webView.isOpaque
                self.wasBackground = webView.backgroundColor
                webView.isOpaque = false
                webView.backgroundColor = .clear
                webView.scrollView.backgroundColor = .clear
                webView.underPageBackgroundColor = .clear
                self.camera.attach(to: host, frame: frame)
                if let lut { self.camera.setLut(base64: lut, n: n) }
                self.camera.start { error in
                    if let error {
                        self.detach()
                        call.reject(error, "camera")
                    } else {
                        call.resolve(self.camera.info())
                    }
                }
            }
        }
    }

    /// Körnung live: amount wie GRAIN.amount, cell als Anteil der Bildbreite (GRAIN.cell in model.ts)
    @objc func setGrain(_ call: CAPPluginCall) {
        camera.setGrain(amount: Float(call.getDouble("amount") ?? 0), cell: Float(call.getDouble("cell") ?? 0))
        call.resolve()
    }

    /// Die Räder (Expertenmodus E1): fehlt ein Wert oder ist er null, steht das Rad auf A
    @objc func setDials(_ call: CAPPluginCall) {
        let d = CalimaCamera.Dials(
            duration: call.getDouble("duration"),
            iso: call.getDouble("iso").map { Float($0) },
            focus: call.getDouble("focus").map { Float($0) },
            kelvin: call.getDouble("kelvin").map { Float($0) },
            tint: call.getDouble("tint").map { Float($0) },
            gains: call.getObject("gains").flatMap { o in
                guard let r = o["r"] as? Double, let g = o["g"] as? Double, let b = o["b"] as? Double else { return nil }
                return AVCaptureDevice.WhiteBalanceGains(redGain: Float(r), greenGain: Float(g), blueGain: Float(b))
            }
        )
        camera.setDials(d)
        call.resolve()
    }

    /// Weiß-Pipette (#184): mittleres Licht im Feld rect (Anteile des Sucherbilds, hochkant, 0…1), linear, vor Look
    /// und Korn, dazu die Gains, die für genau dieses Bild galten. Die Rechnung macht das Web (src/lib/white.ts).
    @objc func measureWhite(_ call: CAPPluginCall) {
        guard let o = call.getObject("rect"), let x = o["x"] as? Double, let y = o["y"] as? Double, let w = o["w"] as? Double, let h = o["h"] as? Double else {
            call.reject("Kein Feld", "white")
            return
        }
        camera.measureWhiteSettled(rect: CGRect(x: x, y: y, width: w, height: h)) { m in
            if let m { call.resolve(m) } else { call.reject("Noch kein Bild", "white") }
        }
    }

    @objc func setMagnify(_ call: CAPPluginCall) {
        camera.magnify = call.getBool("on") ?? false
        call.resolve()
    }

    @objc func setLevel(_ call: CAPPluginCall) {
        camera.setLevel(on: call.getBool("on") ?? false)
        call.resolve()
    }

    @objc func layout(_ call: CAPPluginCall) {
        guard let frame = frame(from: call) else {
            call.reject("frame fehlt")
            return
        }
        DispatchQueue.main.async {
            self.camera.layout(frame: frame)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.detach()
            call.resolve()
        }
    }

    private func detach() {
        camera.stop()
        if let webView {
            webView.isOpaque = wasOpaque
            webView.backgroundColor = wasBackground
            webView.scrollView.backgroundColor = wasBackground
            webView.underPageBackgroundColor = wasBackground ?? .clear
        }
    }

    @objc func setLut(_ call: CAPPluginCall) {
        guard let lut = call.getString("lut") else {
            call.reject("lut fehlt")
            return
        }
        camera.setLut(base64: lut, n: call.getInt("n") ?? 33)
        call.resolve()
    }

    @objc func setOriginal(_ call: CAPPluginCall) {
        camera.original = call.getBool("on") ?? false
        call.resolve()
    }

    @objc func setExposure(_ call: CAPPluginCall) {
        camera.setExposure(ev: Float(call.getDouble("ev") ?? 0))
        call.resolve()
    }

    @objc func setZoom(_ call: CAPPluginCall) {
        let factor = camera.setZoom(CGFloat(call.getDouble("factor") ?? 1))
        call.resolve(["factor": factor])
    }

    @objc func focus(_ call: CAPPluginCall) {
        camera.focus(x: CGFloat(call.getDouble("x") ?? 0.5), y: CGFloat(call.getDouble("y") ?? 0.5), lock: call.getBool("lock") ?? false)
        call.resolve()
    }

    /// Ein fertiges Foto (JPEG als Base64, mit Look) zusätzlich in die Mediathek legen (#210). Fragt nur nach „Fotos
    /// hinzufügen“, nie nach Lesezugriff; deshalb kein eigenes Album (dafür bräuchte es Lesezugriff auf die Mediathek).
    /// Antwort: saved true, oder denied true, wenn die Berechtigung fehlt.
    @objc func saveToLibrary(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("Kein Bild", "library")
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.resolve(["saved": false, "denied": true])
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            }) { ok, error in
                if ok { call.resolve(["saved": true]) } else { call.reject(error?.localizedDescription ?? "Nicht gesichert", "library") }
            }
        }
    }

    @objc func flip(_ call: CAPPluginCall) {
        camera.flip { error in
            if let error { call.reject(error, "camera") } else { call.resolve(self.camera.info()) }
        }
    }

    @objc func capture(_ call: CAPPluginCall) {
        camera.capture(flash: call.getBool("flash") ?? false) { result in
            switch result {
            case .success(let url):
                call.resolve(["path": url.path])
            case .failure(let error):
                call.reject(error.localizedDescription, "capture")
            }
        }
    }

    @objc func discard(_ call: CAPPluginCall) {
        if let path = call.getString("path"), path.hasPrefix(CalimaCamera.folder.path) {
            try? FileManager.default.removeItem(atPath: path)
        }
        call.resolve()
    }
}

/// Quick Action am App-Symbol („Ins Reisebuch fotografieren“, Info.plist): die Aktion bleibt liegen, bis die Seite sie
/// abholt. Beim Kaltstart läuft die Seite noch nicht und fragt selbst nach; aus dem Hintergrund kommt ein `event`.
/// Nur auf dem Hauptthread benutzt (SceneDelegate und DispatchQueue.main).
enum CalimaLaunch {
    static let kamera = "app.calima.kamera"
    static let waiting = Notification.Name("CalimaLaunchWaiting")
    private static var pending: String?

    /// true, wenn die Aktion von Calima ist
    static func receive(_ item: UIApplicationShortcutItem) -> Bool {
        guard item.type == kamera else { return false }
        pending = "kamera"
        NotificationCenter.default.post(name: waiting, object: nil)
        return true
    }

    static func take() -> String? {
        defer { pending = nil }
        return pending
    }
}

/// Kamera-Sitzung, Farbwürfel und Sucher
final class CalimaCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCapturePhotoCaptureDelegate, MTKViewDelegate, AVCaptureSessionControlsDelegate {
    static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("calima-kamera", isDirectory: true)

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.calima.kamera", qos: .userInteractive)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let photoOutput = AVCapturePhotoOutput()
    private var input: AVCaptureDeviceInput?
    private(set) var front = false
    private var running = false

    private var preview: MTKView?
    private let metal = MTLCreateSystemDefaultDevice()
    private lazy var commandQueue = metal?.makeCommandQueue()
    private lazy var ciContext: CIContext? = metal.map { CIContext(mtlDevice: $0, options: [.cacheIntermediates: false]) }
    private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    private var cube: CIFilter?
    /// Körnung wie in der Vorschau (preview.ts): Rauschen in Zellen, weiches Licht, in den Mitten am stärksten
    private var grainAmount: Float = 0
    private var grainCell: Float = 0
    private let noise = CIFilter(name: "CIRandomGenerator")?.outputImage
    private var grainTick: UInt32 = 0
    /// Kamera-Knopf und Lautstärketasten (iOS 17.2) lösen aus; der Web-Teil hört auf das Ereignis „shutter“
    private var shutterInteraction: UIInteraction?
    private var latest: CIImage?
    /// das letzte Sucherbild ohne Look und Korn und die Gains, die dafür galten (für die Weiß-Pipette)
    private var raw: CIImage?
    private var rawGains = AVCaptureDevice.WhiteBalanceGains(redGain: 1, greenGain: 1, blueGain: 1)
    private let lock = NSLock()
    private var drawPending = false
    /// Original zeigen (gedrückt halten): der Würfel bleibt liegen, wird nur nicht angewandt
    var original = false

    private var pendingCapture: ((Result<URL, Error>) -> Void)?

    /// Weitere Analysen der Sucherbilder (Reisebuch-Workshop, Runde 2: Dokument-Ecken, Strichcode, Klassifikation).
    /// Noch leer; ein Erkenner meldet sich mit `onEvent` zurück, die Seite hört über `CalimaCamera.addListener("event", …)`.
    var analyzers: [FrameAnalyzer] = []
    var onEvent: ((String, [String: Any]) -> Void)?
    /// Erkenner laufen nicht auf jedem Bild: nur, wenn der vorige fertig ist
    private var analyzing = false
    /// bei virtuellen Kameras ist 1,0 das Ultraweitwinkel; die Hauptkamera liegt beim ersten Umschaltpunkt
    private var baseZoom: CGFloat = 1
    /// Die virtuelle Rückkamera (Dreifach-Kamera). Apple erlaubt auf ihr weder Zeit/ISO von Hand noch festen Fokus oder
    /// festen Weißabgleich; sobald ein Rad nicht auf A steht, läuft deshalb das passende echte Objektiv (`fitLens`).
    private var virtualDevice: AVCaptureDevice?
    /// Zoom in Einheiten der virtuellen Kamera (1,0 = Ultraweitwinkel), den die Seite gerade will
    private var wantedZoom: CGFloat = 1
    /// Schärfe und Helligkeit per zweitem Tipp festgehalten (focus(lock:)); applyDials lässt sie dann stehen
    private var tapLock = false
    /// zählt die Tipps, damit ein verspätetes Festhalten keinen neueren Tipp überschreibt
    private var lockTicket = 0

    // MARK: Expertenmodus E1: Räder, Messer, Lupe, Wasserwaage (expertenmodus-workshop-2026-10-09/)

    /// Stellung der Räder; nil heißt A (die Kamera stellt selbst)
    struct Dials {
        var duration: Double?
        var iso: Float?
        var focus: Float?
        var kelvin: Float?
        /// Tönung (grün −, magenta +), gilt nur zusammen mit kelvin
        var tint: Float?
        /// gemessenes Weiß (Pipette): feste Gains, gehen vor kelvin
        var gains: AVCaptureDevice.WhiteBalanceGains?
    }
    private var dials = Dials()
    /// Lupe: der Sucher zeigt die Mitte dreifach vergrößert
    var magnify = false
    private var frameTick = 0
    private var lastMeter: (offset: Float, duration: Double, iso: Float, lens: Float, kelvin: Float)?
    private var motion: CMMotionManager?
    /// Lage des Telefons aus dem Beschleunigungssensor (wie die Kamera-App): UIDevice.orientation meldet bei
    /// eingeschalteter Ausrichtungssperre nie quer. upright ist die letzte aufrechte Lage, flach zählt nicht fürs Foto.
    private var orientMotion: CMMotionManager?
    private var orientation: UIDeviceOrientation = .unknown
    private var upright: UIDeviceOrientation = .portrait
    private var lastRoll: Double = .nan

    /// was die Kamera kann: Objektive als Zoomfaktoren zur Hauptkamera, Grenzen von Zeit und ISO
    func info() -> [String: Any] {
        guard let device = input?.device else { return ["front": front, "lenses": [1.0], "limits": [:]] }
        let f = device.activeFormat
        var lenses = device.virtualDeviceSwitchOverVideoZoomFactors.map { Double(CGFloat(truncating: $0) / baseZoom) }
        // das Ultraweitwinkel liegt vor dem ersten Umschaltpunkt
        if device.minAvailableVideoZoomFactor < baseZoom { lenses.insert(Double(device.minAvailableVideoZoomFactor / baseZoom), at: 0) }
        if lenses.isEmpty { lenses = [1] }
        return [
            "front": front,
            "lenses": lenses,
            "limits": [
                "minDuration": CMTimeGetSeconds(f.minExposureDuration),
                "maxDuration": min(CMTimeGetSeconds(f.maxExposureDuration), 1),
                "minISO": Double(f.minISO),
                "maxISO": Double(f.maxISO),
            ],
        ]
    }

    /// Räder stellen. Steht nur Zeit oder nur ISO von Hand, bleibt der andere Wert, wo die Automatik ihn zuletzt hatte: das Bild
    /// wird sichtbar heller oder dunkler, der Messer zeigt, wie weit (Michel, 9.10.: lieber sichtbar als automatisch ausgeglichen).
    func setDials(_ d: Dials) {
        queue.async {
            self.dials = d
            self.fitLens()
            self.applyDials()
        }
    }

    /// Auf der Warteschlange: die Räder ans laufende Objektiv geben
    private func applyDials() {
        let d = dials
        guard let device = input?.device, (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        // Belichtung; auf A nur zurück zur Automatik, wenn vorher von Hand gestellt war (eine Sperre per Tipp bleibt)
        if d.duration == nil && d.iso == nil {
            if device.exposureMode == .custom, device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        } else if device.isExposureModeSupported(.custom) {
            device.setExposureModeCustom(duration: clampDuration(d.duration), iso: clampISO(d.iso), completionHandler: nil)
        }
        // Schärfe
        if let focus = d.focus {
            if device.isLockingFocusWithCustomLensPositionSupported {
                device.setFocusModeLocked(lensPosition: min(max(focus, 0), 1), completionHandler: nil)
            }
        } else if !tapLock, device.focusMode == .locked, device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusMode = .continuousAutoFocus
        }
        // Weiß: gemessene Gains vor Kelvin
        if let g = d.gains {
            if device.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                device.setWhiteBalanceModeLocked(with: clampGains(g, device), completionHandler: nil)
            }
        } else if let kelvin = d.kelvin {
            if device.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                let values = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(temperature: min(max(kelvin, 2000), 10000), tint: min(max(d.tint ?? 0, -150), 150))
                device.setWhiteBalanceModeLocked(with: clampGains(device.deviceWhiteBalanceGains(for: values), device), completionHandler: nil)
            }
        } else if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    private func clampDuration(_ s: Double?) -> CMTime {
        guard let device = input?.device, let s else { return AVCaptureDevice.currentExposureDuration }
        let f = device.activeFormat
        let lo = CMTimeGetSeconds(f.minExposureDuration)
        let hi = min(CMTimeGetSeconds(f.maxExposureDuration), 1)
        return CMTime(seconds: min(max(s, lo), hi), preferredTimescale: 1_000_000)
    }

    private func clampISO(_ iso: Float?) -> Float {
        guard let device = input?.device, let iso else { return AVCaptureDevice.currentISO }
        return min(max(iso, device.activeFormat.minISO), device.activeFormat.maxISO)
    }

    private func clampGains(_ g: AVCaptureDevice.WhiteBalanceGains, _ device: AVCaptureDevice) -> AVCaptureDevice.WhiteBalanceGains {
        let hi = device.maxWhiteBalanceGain
        var out = g
        out.redGain = min(max(g.redGain, 1), hi)
        out.greenGain = min(max(g.greenGain, 1), hi)
        out.blueGain = min(max(g.blueGain, 1), hi)
        return out
    }

    /// Alle paar Bilder: Messung an die Seite („meter“) und, wenn nur Zeit oder nur ISO fest steht, das andere nachregeln
    private func meter() {
        guard let device = input?.device else { return }
        frameTick &+= 1
        guard frameTick % 6 == 0 else { return }
        let offset = device.exposureTargetOffset
        let duration = CMTimeGetSeconds(device.exposureDuration)
        let iso = device.iso
        let lens = device.lensPosition
        var kelvin: Float = 0
        let gains = device.deviceWhiteBalanceGains
        if gains.redGain >= 1, gains.greenGain >= 1, gains.blueGain >= 1, gains.redGain <= device.maxWhiteBalanceGain, gains.blueGain <= device.maxWhiteBalanceGain {
            kelvin = device.temperatureAndTintValues(for: gains).temperature
        }
        // Halbautomatik (Michels Wahl „Ausgleichen“): steht nur Zeit oder nur ISO von Hand, regelt die Kamera das andere nach,
        // damit das Foto richtig belichtet bleibt. Der Chip zeigt den ausgleichenden Wert („Zeit A 1/4“). Halbe Schritte, sonst pendelt es
        let semi = (dials.duration == nil) != (dials.iso == nil)
        if semi, abs(offset) > 0.15, offset.isFinite, device.isExposureModeSupported(.custom), (try? device.lockForConfiguration()) != nil {
            let k = pow(2, Double(-offset) * 0.5)
            if let d = dials.duration {
                device.setExposureModeCustom(duration: clampDuration(d), iso: clampISO(iso * Float(k)), completionHandler: nil)
            } else if let i = dials.iso {
                device.setExposureModeCustom(duration: clampDuration(duration * k), iso: clampISO(i), completionHandler: nil)
            }
            device.unlockForConfiguration()
        }
        let now = (offset: offset, duration: duration, iso: iso, lens: lens, kelvin: kelvin)
        if let l = lastMeter, abs(l.offset - now.offset) < 0.05, abs(l.duration - now.duration) / max(now.duration, 1e-6) < 0.05, abs(l.iso - now.iso) / max(now.iso, 1) < 0.05, abs(l.lens - now.lens) < 0.01, abs(l.kelvin - now.kelvin) < 50 { return }
        lastMeter = now
        onEvent?("meter", ["offset": Double(offset), "duration": duration, "iso": Double(iso), "lens": Double(lens), "kelvin": Double(kelvin)])
    }

    /// Wasserwaage aus der Lage des Telefons; meldet „level“ mit roll in Grad (0 = gerade, hochkant gehalten)
    func setLevel(on: Bool) {
        if !on {
            motion?.stopDeviceMotionUpdates()
            motion = nil
            lastRoll = .nan
            return
        }
        guard motion == nil else { return }
        let m = CMMotionManager()
        guard m.isDeviceMotionAvailable else { return }
        m.deviceMotionUpdateInterval = 1 / 15
        motion = m
        m.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let g = data?.gravity else { return }
            var roll = atan2(g.x, -g.y) * 180 / .pi
            // quer gehalten: die Waage bezieht sich auf die nächste Kante
            if roll > 45 { roll -= 90 } else if roll < -45 { roll += 90 }
            if roll.isFinite, abs(roll - self.lastRoll) >= 0.2 || self.lastRoll.isNaN {
                self.lastRoll = roll
                self.onEvent?("level", ["roll": roll])
            }
        }
    }

    // MARK: Aufbau

    func attach(to host: UIView, frame: CGRect) {
        guard let metal else { return }
        let view = preview ?? MTKView(frame: frame, device: metal)
        view.frame = frame
        view.framebufferOnly = false
        view.isPaused = true
        view.enableSetNeedsDisplay = false
        view.colorPixelFormat = .bgra8Unorm
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        view.delegate = self
        if view.superview == nil { host.insertSubview(view, at: 0) }
        preview = view
        if #available(iOS 17.2, *), shutterInteraction == nil {
            let interaction = AVCaptureEventInteraction { [weak self] event in
                if event.phase == .ended { self?.onEvent?("shutter", [:]) }
            }
            host.addInteraction(interaction)
            shutterInteraction = interaction
        }
    }

    func layout(frame: CGRect) {
        preview?.frame = frame
    }

    func start(_ done: @escaping (String?) -> Void) {
        startOrientation()
        queue.async {
            do {
                try self.configure(position: .back)
                self.session.startRunning()
                self.running = true
                done(nil)
            } catch {
                done(error.localizedDescription)
            }
        }
    }

    func stop() {
        let view = preview
        preview = nil
        if let shutterInteraction { view?.superview?.removeInteraction(shutterInteraction) }
        shutterInteraction = nil
        view?.removeFromSuperview()
        setLevel(on: false)
        orientMotion?.stopAccelerometerUpdates()
        orientMotion = nil
        magnify = false
        queue.async {
            self.dials = Dials()
            self.tapLock = false
            if self.running {
                self.session.stopRunning()
                self.running = false
            }
            try? FileManager.default.removeItem(at: CalimaCamera.folder)
        }
        lock.lock()
        latest = nil
        lock.unlock()
    }

    // MARK: Querformat (#253): das Web dreht Knöpfe mit, die Oberfläche selbst bleibt hochkant

    private func startOrientation() {
        orientMotion?.stopAccelerometerUpdates()
        orientation = .unknown
        let m = CMMotionManager()
        guard m.isAccelerometerAvailable else {
            sendOrientation(UIDevice.current.orientation)
            return
        }
        m.accelerometerUpdateInterval = 0.15
        m.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let a = data?.acceleration else { return }
            // Schwerkraft zeigt nach unten: hochkant y ≈ −1, Oberkante links (landscapeLeft) x ≈ −1, flach z ≈ ∓1.
            // Ein Abstand von 0,25 zwischen den Achsen verhindert Flattern um die Diagonale.
            let o: UIDeviceOrientation
            if abs(a.z) > 0.85 { o = a.z < 0 ? .faceUp : .faceDown }
            else if abs(a.x) > abs(a.y) + 0.25 { o = a.x < 0 ? .landscapeLeft : .landscapeRight }
            else if abs(a.y) > abs(a.x) + 0.25 { o = a.y < 0 ? .portrait : .portraitUpsideDown }
            else { return }
            if o != self.orientation { self.sendOrientation(o) }
        }
        orientMotion = m
    }

    private func sendOrientation(_ o: UIDeviceOrientation) {
        orientation = o
        if o.isPortrait || o.isLandscape { upright = o }
        let name: String
        switch o {
        case .portrait: name = "portrait"
        case .portraitUpsideDown: name = "portraitUpsideDown"
        case .landscapeLeft: name = "landscapeLeft"
        case .landscapeRight: name = "landscapeRight"
        case .faceUp: name = "faceUp"
        case .faceDown: name = "faceDown"
        default: name = "unknown"
        }
        onEvent?("orientation", ["orientation": name])
    }

    private func device(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let types: [AVCaptureDevice.DeviceType] = position == .back
            ? [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
            : [.builtInWideAngleCamera]
        return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: position).devices.first
    }

    private func configure(position: AVCaptureDevice.Position) throws {
        guard let device = device(for: position) else { throw NSError(domain: "calima", code: 1, userInfo: [NSLocalizedDescriptionKey: "Keine Kamera"]) }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        if let old = input { session.removeInput(old) }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw NSError(domain: "calima", code: 2, userInfo: [NSLocalizedDescriptionKey: "Kamera belegt"]) }
        session.addInput(input)
        self.input = input
        front = position == .front

        if !session.outputs.contains(videoOutput) {
            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
        }
        if !session.outputs.contains(photoOutput), session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
        }
        photoOutput.maxPhotoQualityPrioritization = .balanced
        if #available(iOS 17.0, *), photoOutput.isZeroShutterLagSupported {
            photoOutput.isZeroShutterLagEnabled = true
        }
        if let c = videoOutput.connection(with: .video) {
            rotate(c, angle: 90)
            if c.isVideoMirroringSupported {
                c.automaticallyAdjustsVideoMirroring = false
                c.isVideoMirrored = front
            }
        }
        // Hauptkamera (24 mm) als Ausgangslage, nicht das Ultraweitwinkel
        baseZoom = device.virtualDeviceSwitchOverVideoZoomFactors.first.map { CGFloat(truncating: $0) } ?? 1
        wantedZoom = baseZoom
        virtualDevice = device.isVirtualDevice ? device : nil
        zoomSlider(for: device)
        try? device.lockForConfiguration()
        device.videoZoomFactor = baseZoom
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        device.unlockForConfiguration()
    }

    /// Kamera-Knopf (iOS 18): Wischen darauf zoomt wie zwei Finger; der Web-Teil hört „zoom“ und zeigt die Zahl.
    /// Nur auf der virtuellen Kamera: auf einem einzelnen Objektiv würde er an den anderen vorbei zoomen.
    private func zoomSlider(for device: AVCaptureDevice?) {
        guard #available(iOS 18.0, *), session.supportsControls else { return }
        for c in session.controls { session.removeControl(c) }
        guard let device else { return }
        let slider = AVCaptureSystemZoomSlider(device: device) { [weak self] factor in
            guard let self else { return }
            self.wantedZoom = factor
            self.onEvent?("zoom", ["factor": Double(factor / self.baseZoom)])
        }
        if session.canAddControl(slider) {
            session.addControl(slider)
            session.setControlsDelegate(self, queue: queue)
        }
    }

    /// Objektiv der virtuellen Kamera, das den Zoom `v` abdeckt, und wo es in ihren Einheiten anfängt
    private func lens(for v: CGFloat) -> (device: AVCaptureDevice, start: CGFloat)? {
        guard let virtualDevice else { return nil }
        let lenses = virtualDevice.constituentDevices
        let starts = [CGFloat(1)] + virtualDevice.virtualDeviceSwitchOverVideoZoomFactors.map { CGFloat(truncating: $0) }
        guard !lenses.isEmpty, lenses.count == starts.count else { return nil }
        let i = starts.lastIndex { $0 <= v * 1.001 } ?? 0
        return (lenses[i], starts[i])
    }

    /// Auf der Warteschlange: steht ein Rad nicht auf A, läuft das echte Objektiv zur Brennweite, sonst die virtuelle Kamera.
    /// Danach den Zoom so setzen, dass der Ausschnitt gleich bleibt.
    private func fitLens() {
        guard let virtualDevice, !front, let current = input?.device else { return }
        // feste Gains (Pipette) kann die virtuelle Dreifach-Kamera so wenig wie Kelvin
        let manual = dials.duration != nil || dials.iso != nil || dials.focus != nil || dials.kelvin != nil || dials.gains != nil
        let target = manual ? lens(for: wantedZoom) : (virtualDevice, CGFloat(1))
        guard let target else { return }
        if target.device != current, let next = try? AVCaptureDeviceInput(device: target.device) {
            session.beginConfiguration()
            if let old = input { session.removeInput(old) }
            if session.canAddInput(next) {
                session.addInput(next)
                input = next
            } else if let old = input, session.canAddInput(old) {
                session.addInput(old)
            }
            if let c = videoOutput.connection(with: .video) { rotate(c, angle: 90) }
            session.commitConfiguration()
            zoomSlider(for: input?.device == virtualDevice ? virtualDevice : nil)
            // neues Objektiv: frisch auf Automatik, die Räder legt applyDials gleich danach darüber
            tapLock = false
            if let device = input?.device, (try? device.lockForConfiguration()) != nil {
                if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
                device.unlockForConfiguration()
            }
        }
        // sonst nur den Zoom: Belichtung und Schärfe auf Automatik zurückzusetzen ließ sie bei jeder Rad-Bewegung pumpen
        guard let device = input?.device, (try? device.lockForConfiguration()) != nil else { return }
        let start = device == virtualDevice ? 1 : target.start
        device.videoZoomFactor = min(max(wantedZoom / start, device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
        device.unlockForConfiguration()
    }

    private func rotate(_ c: AVCaptureConnection, angle: CGFloat) {
        if #available(iOS 17.0, *) {
            if c.isVideoRotationAngleSupported(angle) { c.videoRotationAngle = angle }
        } else if c.isVideoOrientationSupported {
            c.videoOrientation = angle == 90 ? .portrait : angle == 0 ? .landscapeRight : angle == 180 ? .landscapeLeft : .portraitUpsideDown
        }
    }

    func flip(_ done: @escaping (String?) -> Void) {
        queue.async {
            self.dials = Dials()
            self.tapLock = false
            do {
                try self.configure(position: self.front ? .back : .front)
                done(nil)
            } catch {
                done(error.localizedDescription)
            }
        }
    }

    // MARK: Look

    /// RGBA8-Würfel aus dem Web-Teil (Index (b·n + g)·n + r wie in model.ts) als Gleitkomma-Würfel für Core Image
    func setLut(base64: String, n: Int) {
        guard n >= 2, n <= 64, let bytes = Data(base64Encoded: base64), bytes.count == n * n * n * 4 else { return }
        var floats = [Float](repeating: 0, count: bytes.count)
        bytes.withUnsafeBytes { raw in
            for i in 0..<bytes.count { floats[i] = Float(raw[i]) / 255 }
        }
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        let f = CIFilter(name: "CIColorCubeWithColorSpace")
        f?.setValue(n, forKey: "inputCubeDimension")
        f?.setValue(data, forKey: "inputCubeData")
        f?.setValue(srgb, forKey: "inputColorSpace")
        lock.lock()
        cube = f
        lock.unlock()
    }

    func setGrain(amount: Float, cell: Float) {
        lock.lock()
        grainAmount = amount
        grainCell = cell
        lock.unlock()
    }

    /// Körnung wie preview.ts: Rauschen je Zelle, nur auf der Helligkeit (Mitten am stärksten, Lichter und Tiefen kaum).
    /// Das Rauschen springt je Bild, damit es wie Film flimmert und nicht wie Schmutz auf dem Glas klebt.
    /// Wie applyGrain in model.ts: Rauschen ±amount um Mittelgrau, overlay-artig, in den Mitten am stärksten. Gemischt wird in
    /// Gamma-Werten (sRGB) wie im Web, nicht im linearen Arbeitsraum von Core Image: dort hellte dieselbe Körnung dunkle Stellen
    /// um ein Vielfaches auf (Salz-und-Pfeffer statt Korn).
    private func grained(_ image: CIImage) -> CIImage {
        guard let noise else { return image }
        let cellPx = max(1, CGFloat(grainCell) * image.extent.width)
        // jedes Bild ein frisches Stück Rauschen (Zufallsversatz weit auseinander), nicht ein gleichmäßig weitergeschobenes:
        // das liest das Auge sonst als Wind, der über den Sucher zieht
        grainTick = grainTick &* 1664525 &+ 1013904223
        let dx = CGFloat((grainTick >> 8) & 0x3fff) * cellPx
        let dy = CGFloat((grainTick >> 18) & 0x3fff) * cellPx
        let k = CGFloat(grainAmount) * 2
        let grain = noise
            .samplingNearest()
            .transformed(by: CGAffineTransform(translationX: dx, y: dy).scaledBy(x: cellPx, y: cellPx))
            // Als Zufallszahl dient der Alphakanal, nicht Rot: CIRandomGenerator würfelt alle vier Kanäle einzeln, und Core
            // Image rechnet mit vormultiplizierten Farben. Rot durch Alpha geteilt läuft bei jedem zweiten Pixel auf 1 hinaus,
            // das Korn wurde zu lauter hellen Sprenkeln (Kalkwand, Nachmittag). Alpha selbst bleibt gleichverteilt.
            .applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 0, y: 0, z: 0, w: k),
                "inputGVector": CIVector(x: 0, y: 0, z: 0, w: k),
                "inputBVector": CIVector(x: 0, y: 0, z: 0, w: k),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: 0.5 - k / 2, y: 0.5 - k / 2, z: 0.5 - k / 2, w: 1),
            ])
            // erst nach dem Farbfilter zuschneiden: der macht auch den leeren Rand undurchsichtig, das Bild wäre sonst unendlich
            // groß und würde beim Einpassen in den Sucher auf nichts verkleinert (schwarzer Sucher)
            .cropped(to: image.extent)
        let gamma = image.applyingFilter("CILinearToSRGBToneCurve")
        // Das Korn nur auf die Helligkeit legen, nie auf die Farbkanäle einzeln: Overlay entscheidet je Kanal, ob es aufhellt
        // oder abdunkelt, und bei einer satten Farbe geht Rot hoch, während Blau runtergeht. Das sah aus wie buntes Rauschen.
        // Im Web (applyGrain) bekommt jeder Kanal denselben Zuschlag; hier: Korn über das Grauwertbild, dann nur die Helligkeit
        // davon ins Farbbild übernehmen (CILuminosityBlendMode: Farbton und Sättigung vom Hintergrund, Helligkeit vom Korn).
        let luma = CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0)
        let grey = gamma.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": luma,
            "inputGVector": luma,
            "inputBVector": luma,
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        ])
        return grain
            .applyingFilter("CIOverlayBlendMode", parameters: [kCIInputBackgroundImageKey: grey])
            .applyingFilter("CILuminosityBlendMode", parameters: [kCIInputBackgroundImageKey: gamma])
            .applyingFilter("CISRGBToneCurveToLinear")
    }

    // MARK: Kamera-Knopf (AVCaptureSessionControlsDelegate): nichts zu tun, der Web-Teil zeigt die Werte selbst

    func sessionControlsDidBecomeActive(_ session: AVCaptureSession) {}
    func sessionControlsWillEnterFullscreenAppearance(_ session: AVCaptureSession) {}
    func sessionControlsWillExitFullscreenAppearance(_ session: AVCaptureSession) {}
    func sessionControlsDidBecomeInactive(_ session: AVCaptureSession) {}

    func setExposure(ev: Float) {
        guard let device = input?.device else { return }
        queue.async {
            guard (try? device.lockForConfiguration()) != nil else { return }
            let v = min(max(ev, device.minExposureTargetBias), device.maxExposureTargetBias)
            device.setExposureTargetBias(v)
            device.unlockForConfiguration()
        }
    }

    /// factor 1 = Hauptkamera; zurück kommt, was die Kamera wirklich eingestellt hat
    @discardableResult
    func setZoom(_ factor: CGFloat) -> Double {
        guard let device = input?.device else { return 1 }
        if let virtualDevice, device != virtualDevice {
            // von Hand: der Ausschnitt kann ein anderes Objektiv brauchen
            return queue.sync {
                wantedZoom = min(max(baseZoom * factor, virtualDevice.minAvailableVideoZoomFactor), baseZoom * 10)
                fitLens()
                applyDials()
                return Double(wantedZoom / baseZoom)
            }
        }
        let lo = device.minAvailableVideoZoomFactor
        let hi = min(device.maxAvailableVideoZoomFactor, baseZoom * 10)
        let v = min(max(baseZoom * factor, lo), hi)
        if (try? device.lockForConfiguration()) != nil {
            device.videoZoomFactor = v
            device.unlockForConfiguration()
        }
        wantedZoom = v
        return Double(v / baseZoom)
    }

    /// x, y in 0..1 des Suchers (hochkant); die Kamera rechnet quer, deshalb gedreht
    /// Tippen: an der Stelle scharf stellen und messen. lock hält danach Schärfe und Helligkeit fest (AE/AF-Sperre:
    /// einmal messen, dann stehen lassen). Räder von Hand bleiben, wie sie sind.
    func focus(x: CGFloat, y: CGFloat, lock: Bool = false) {
        let p = CGPoint(x: min(max(y, 0), 1), y: min(max(1 - x, 0), 1))
        queue.async {
            guard let device = self.input?.device, (try? device.lockForConfiguration()) != nil else { return }
            defer { device.unlockForConfiguration() }
            self.tapLock = lock
            self.lockTicket &+= 1
            let focusFree = !self.front && self.dials.focus == nil
            let exposureFree = self.dials.duration == nil && self.dials.iso == nil
            // erst an der Stelle messen (fortlaufend, wie die Kamera-App: folgt der Stelle, bis man woanders tippt)
            if focusFree, device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusPointOfInterest = p
                device.focusMode = .continuousAutoFocus
            }
            if exposureFree, device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposurePointOfInterest = p
                device.exposureMode = .continuousAutoExposure
            }
            guard lock else { return }
            // dann festhalten, sobald Schärfe und Licht sich gesetzt haben; ein neuer Tipp in der Zwischenzeit gewinnt
            let ticket = self.lockTicket
            self.queue.asyncAfter(deadline: .now() + 0.6) {
                guard ticket == self.lockTicket, self.tapLock, let device = self.input?.device, (try? device.lockForConfiguration()) != nil else { return }
                defer { device.unlockForConfiguration() }
                if focusFree, device.isFocusModeSupported(.locked) { device.focusMode = .locked }
                if exposureFree, device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
            }
        }
    }

    // MARK: Sucher

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        meter()
        var image = CIImage(cvPixelBuffer: buffer)
        let gains = input?.device.deviceWhiteBalanceGains
        lock.lock()
        raw = image
        if let gains { rawGains = gains }
        if !original, let cube {
            cube.setValue(image, forKey: kCIInputImageKey)
            image = cube.outputImage ?? image
            if grainAmount > 0 { image = grained(image) }
        }
        latest = image
        let pending = drawPending
        drawPending = true
        let analyze = !analyzers.isEmpty && !analyzing
        if analyze { analyzing = true }
        lock.unlock()
        if analyze {
            let list = analyzers
            DispatchQueue.global(qos: .utility).async {
                for a in list { a.analyze(buffer, emit: { [weak self] name, data in self?.onEvent?(name, data) }) }
                self.lock.lock(); self.analyzing = false; self.lock.unlock()
            }
        }
        // nur ein Zeichnen auf einmal: kommt der Hauptthread nicht nach, fällt ein Bild weg statt sich zu stauen
        if !pending {
            DispatchQueue.main.async { self.preview?.draw() }
        }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        lock.lock()
        drawPending = false
        let image = latest
        lock.unlock()
        guard var image, let ciContext, let commandQueue, let drawable = view.currentDrawable, let buffer = commandQueue.makeCommandBuffer() else { return }
        // Lupe: das mittlere Drittel füllt den Sucher, zum Scharfstellen von Hand
        if magnify {
            let e = image.extent
            image = image.cropped(to: CGRect(x: e.midX - e.width / 6, y: e.midY - e.height / 6, width: e.width / 3, height: e.height / 3))
        }
        // Bild in die Ansicht einpassen (das Seitenverhältnis stellt der Web-Teil, 3:4 wie das Foto)
        let size = view.drawableSize
        let scale = min(size.width / image.extent.width, size.height / image.extent.height)
        let w = image.extent.width * scale
        let h = image.extent.height * scale
        let placed = image
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: (size.width - w) / 2 - image.extent.minX * scale, y: (size.height - h) / 2 - image.extent.minY * scale))
        ciContext.render(placed, to: drawable.texture, commandBuffer: buffer, bounds: CGRect(origin: .zero, size: size), colorSpace: srgb)
        buffer.present(drawable)
        buffer.commit()
    }

    // MARK: Auslösen

    /// flash: echter Blitz für dieses Bild (Einwegkamera), sofern das Objektiv einen kann
    func capture(flash: Bool = false, _ done: @escaping (Result<URL, Error>) -> Void) {
        queue.async {
            guard self.running else {
                done(.failure(NSError(domain: "calima", code: 3, userInfo: [NSLocalizedDescriptionKey: "Kamera läuft nicht"])))
                return
            }
            guard self.pendingCapture == nil else {
                done(.failure(NSError(domain: "calima", code: 4, userInfo: [NSLocalizedDescriptionKey: "Noch beim Auslösen"])))
                return
            }
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            // Zeit von Hand (etwa 1/6 s): .balanced verrechnet mehrere Bilder und verlängert die Aufnahme spürbar,
            // .speed nimmt genau die eingestellte Belichtung
            settings.photoQualityPrioritization = self.dials.duration != nil ? .speed : .balanced
            if flash, self.photoOutput.supportedFlashModes.contains(.on) { settings.flashMode = .on }
            if let c = self.photoOutput.connection(with: .video) {
                self.rotate(c, angle: self.angle())
                if c.isVideoMirroringSupported { c.isVideoMirrored = self.front }
            }
            self.pendingCapture = done
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    /// Wie measureWhite, aber erst, wenn Belichtung und Weiß stillstehen und danach ein paar neue Bilder kamen (höchstens
    /// 1,5 s). Nach einem Objektivwechsel sind die ersten Bilder dunkel und die Gains noch unterwegs; so gemessen kippte
    /// die Pipette in der zweiten Runde (am iPhone gesehen: r/g/b um 0,04, danach überkorrigiert ins Blaue).
    func measureWhiteSettled(rect: CGRect, _ done: @escaping ([String: Any]?) -> Void) {
        let start = Date()
        var calm = 0
        var lastTick = frameTick
        func poll() {
            let device = input?.device
            let busy = device.map { $0.isAdjustingExposure || $0.isAdjustingWhiteBalance || $0.isAdjustingFocus } ?? false
            let tick = frameTick
            if !busy, tick != lastTick { calm += 1 } else if busy { calm = 0 }
            lastTick = tick
            if calm >= 3 || Date().timeIntervalSince(start) > 1.5 {
                done(measureWhite(rect: rect))
                return
            }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.04) { poll() }
        }
        poll()
    }

    /// Mittel des Felds rect (hochkant, oben links 0/0) im letzten rohen Sucherbild, linear, mit den Gains dieses Bilds.
    /// Das Sucherbild kommt schon hochkant (Verbindung um 90° gedreht); Core Image zählt y von unten.
    func measureWhite(rect: CGRect) -> [String: Any]? {
        lock.lock()
        let image = raw
        let gains = rawGains
        lock.unlock()
        guard let image, let ciContext, let linear = CGColorSpace(name: CGColorSpace.linearSRGB) else { return nil }
        let e = image.extent
        let area = CGRect(x: e.minX + rect.minX * e.width, y: e.minY + (1 - rect.maxY) * e.height, width: rect.width * e.width, height: rect.height * e.height)
        let avg = image.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: area)])
        var px = [Float](repeating: 0, count: 4)
        ciContext.render(avg, toBitmap: &px, rowBytes: 16, bounds: CGRect(origin: avg.extent.origin, size: CGSize(width: 1, height: 1)), format: .RGBAf, colorSpace: linear)
        return [
            "r": Double(px[0]), "g": Double(px[1]), "b": Double(px[2]),
            "gains": ["r": Double(gains.redGain), "g": Double(gains.greenGain), "b": Double(gains.blueGain)],
        ]
    }

    /// Drehung fürs Foto nach der Lage des Telefons (die Oberfläche selbst bleibt hochkant)
    private func angle() -> CGFloat {
        switch upright {
        case .landscapeLeft: return front ? 180 : 0
        case .landscapeRight: return front ? 0 : 180
        case .portraitUpsideDown: return 270
        default: return 90
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let done = pendingCapture
        pendingCapture = nil
        if let error {
            done?(.failure(error))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            done?(.failure(NSError(domain: "calima", code: 5, userInfo: [NSLocalizedDescriptionKey: "Kein Bild"])))
            return
        }
        do {
            try FileManager.default.createDirectory(at: CalimaCamera.folder, withIntermediateDirectories: true)
            let url = CalimaCamera.folder.appendingPathComponent("calima-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
            try data.write(to: url, options: .atomic)
            done?(.success(url))
        } catch {
            done?(.failure(error))
        }
    }
}

/// Ein Erkenner für Sucherbilder; `emit` schickt ein Ereignis mit Namen und Daten an die Seite (etwa „vorschlag“ mit einer Vorlage)
protocol FrameAnalyzer: AnyObject {
    func analyze(_ pixelBuffer: CVPixelBuffer, emit: @escaping (String, [String: Any]) -> Void)
}

import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Capacitor's web view, with iOS 26's scroll edge effects turned off: the page
/// fills the screen and pads itself clear of the status bar and home indicator
/// (the safe-area utilities in src/styles.css), so iOS needn't fade the page
/// behind them. The status bar's text color follows the app's theme
/// (src/components/status-bar.tsx). Pages come from AppRouter.
class AppViewController: CAPBridgeViewController {
    override func router() -> Router {
        return AppRouter()
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
            webView?.scrollView.bottomEdgeEffect.isHidden = true
        }
    }
}


/// The file for a URL path, as the Electron app (electron/main.ts) and the hosted
/// site resolve it: the file itself, then the prerendered page (/about is
/// about.html or about/index.html), then its route's page, prerendered by its
/// pattern (/sessions/<id> is sessions/$sessionId/index.html, see vite.config.ts),
/// else index.html. Capacitor's own router answers every path without an
/// extension with index.html, the page prerendered for "/", which React finds
/// was rendered for another page.
struct AppRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        let segments = path.split(separator: "/").map(String.init).filter { $0 != "." && $0 != ".." }
        let file = ([basePath] + segments).joined(separator: "/")
        for candidate in [file, file + ".html", file + "/index.html"] where isFile(candidate) {
            return candidate
        }
        // A missing file (a script, an image) stays missing.
        if !URL(fileURLWithPath: path).pathExtension.isEmpty {
            return file
        }
        return routePage(segments) ?? basePath + "/index.html"
    }

    /// Each segment is the folder of that name, or else the folder of a
    /// parameter ($name) beside it.
    private func routePage(_ segments: [String]) -> String? {
        var dir = basePath
        for segment in segments {
            let named = dir + "/" + segment
            if isDirectory(named) {
                dir = named
                continue
            }
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
            guard let param = entries.first(where: { $0.hasPrefix("$") && isDirectory(dir + "/" + $0) }) else {
                return nil
            }
            dir += "/" + param
        }
        let page = dir + "/index.html"
        return isFile(page) ? page : nil
    }

    private func isFile(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }
}

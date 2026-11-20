import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var launchOverlay: UIView?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        self.window = window
        let content: QuizWebViewController
        if #available(iOS 26.0, *) {
            let nativeContent = QuizBridgeViewController()
            let tabs = QuizNativeTabBarController(content: nativeContent)
            nativeContent.nativeTabs = tabs
            tabs.onTabSelected = { [weak nativeContent] tab in nativeContent?.selectWebTab(tab) }
            tabs.onQuestionSwipe = { [weak nativeContent] direction in nativeContent?.swipeWebQuestion(direction) }
            content = nativeContent
            window.rootViewController = tabs
        } else {
            content = QuizWebViewController()
            window.rootViewController = content
        }
        content.onFirstPageLoaded = { [weak self] in self?.dismissLaunch() }
        showLaunch(in: window)
        window.makeKeyAndVisible()
        if let launchOverlay { window.bringSubviewToFront(launchOverlay) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    private func showLaunch(in window: UIWindow) {
        let overlay = UIView(frame: window.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = UIColor(named: "LaunchBackground")?.resolvedColor(with: window.traitCollection)
        overlay.isUserInteractionEnabled = false
        overlay.accessibilityElementsHidden = true

        let logo = UIImageView(image: UIImage(named: "Splash"))
        logo.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(logo)
        NSLayoutConstraint.activate([
            logo.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            logo.centerYAnchor.constraint(equalTo: overlay.centerYAnchor)
        ])

        window.addSubview(overlay)
        launchOverlay = overlay
        // The first painted page normally dismisses the overlay. A failed load can still fall through.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.dismissLaunch() }
    }

    private func dismissLaunch() {
        guard let overlay = launchOverlay else { return }
        launchOverlay = nil
        if UIAccessibility.isReduceMotionEnabled {
            overlay.removeFromSuperview()
            return
        }
        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut]) {
            overlay.alpha = 0
        } completion: { _ in
            overlay.removeFromSuperview()
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

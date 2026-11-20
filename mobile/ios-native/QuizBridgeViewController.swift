import Capacitor
import UIKit
import WebKit

class QuizWebViewController: CAPBridgeViewController {
    private var mediaDelegate: QuizMediaUIDelegate?
    private var firstPageObservation: NSKeyValueObservation?
    var onFirstPageLoaded: (() -> Void)?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView else { return }
        let delegate = QuizMediaUIDelegate(forwarding: webView.uiDelegate)
        mediaDelegate = delegate
        webView.uiDelegate = delegate
        firstPageObservation = webView.observe(\.isLoading) { [weak self] view, _ in
            guard !view.isLoading, view.url != nil else { return }
            self?.firstPageObservation = nil
            let ready = self?.onFirstPageLoaded
            self?.onFirstPageLoaded = nil
            // Give WebKit a frame to paint underneath the launch view.
            view.callAsyncJavaScript(
                "await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));",
                arguments: [:], in: nil, in: .defaultClient
            ) { _ in ready?() }
        }
    }
}

private final class QuizMediaUIDelegate: NSObject, WKUIDelegate {
    private weak var original: WKUIDelegate?

    init(forwarding original: WKUIDelegate?) {
        self.original = original
    }

    // Keep Capacitor's existing UI delegate for alerts, prompts, and new windows.
    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || original?.responds(to: selector) == true
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if original?.responds(to: selector) == true { return original }
        return super.forwardingTarget(for: selector)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        let trustedOrigin = origin.protocol == "capacitor" && origin.host == "localhost" && origin.port == 0
        decisionHandler(trustedOrigin && frame.isMainFrame && type == .microphone ? .grant : .deny)
    }
}

@available(iOS 26.0, *)
final class QuizBridgeViewController: QuizWebViewController {
    weak var nativeTabs: QuizNativeTabBarController?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.configuration.userContentController.addScriptMessageHandler(
            QuizNativeMessageHandler(controller: self), contentWorld: .page, name: "quizNativeUI"
        )
    }

    func selectWebTab(_ tab: String) {
        webView?.callAsyncJavaScript(
            "window.QuizNativeUI?.selectTab(tab, animate);",
            arguments: ["tab": tab, "animate": !UIAccessibility.isReduceMotionEnabled],
            in: nil, in: .page, completionHandler: nil
        )
    }

    func swipeWebQuestion(_ direction: Int) {
        webView?.callAsyncJavaScript(
            "window.QuizNativeUI?.swipeQuestion(direction);",
            arguments: ["direction": direction], in: nil, in: .page, completionHandler: nil
        )
    }

    fileprivate func handle(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === webView, message.frameInfo.isMainFrame,
              origin.protocol == "capacitor", origin.host == "localhost",
              let body = message.body as? [String: Any], let kind = body["kind"] as? String else {
            reply(nil, "Native UI requires the bundled quiz page.")
            return
        }

        if kind == "tab", let tab = body["tab"] as? String {
            nativeTabs?.selectTab(tab, animated: body["animate"] as? Bool ?? true)
            reply(true, nil)
            return
        }
        if kind == "question-swipe", let enabled = body["enabled"] as? Bool {
            nativeTabs?.setQuestionSwipeEnabled(enabled)
            reply(true, nil)
            return
        }
        if kind == "theme", let dark = body["dark"] as? Bool {
            let style: UIUserInterfaceStyle = dark ? .dark : .light
            overrideUserInterfaceStyle = style
            nativeTabs?.overrideUserInterfaceStyle = style
            view.window?.overrideUserInterfaceStyle = style
            if let accent = body["accent"] as? Int, (0...0xffffff).contains(accent) {
                let tint = UIColor(
                    red: CGFloat((accent >> 16) & 255) / 255,
                    green: CGFloat((accent >> 8) & 255) / 255,
                    blue: CGFloat(accent & 255) / 255,
                    alpha: 1
                )
                nativeTabs?.view.tintColor = tint
                nativeTabs?.tabBar.tintColor = tint
            }
            reply(true, nil)
            return
        }

        guard let presenter = nativeTabs, presenter.viewIfLoaded?.window != nil else {
            reply(nil, "Native UI is unavailable.")
            return
        }
        if presenter.presentedViewController != nil {
            reply(["value": NSNull()], nil)
            return
        }

        switch kind {
        case "choices":
            guard let title = body["title"] as? String, let selected = body["selected"] as? String,
                  let items = body["items"] as? [[String: Any]], !items.isEmpty else {
                reply(nil, "Expected a list of quiz choices.")
                return
            }
            let choices = items.compactMap { item -> QuizNativeChoice? in
                guard let value = item["value"] as? String, let title = item["title"] as? String else { return nil }
                return QuizNativeChoice(value: value, title: title, detail: item["detail"] as? String)
            }
            guard choices.count == items.count else {
                reply(nil, "Expected a value and label for each quiz choice.")
                return
            }
            QuizNativeSheets.presentChoices(on: presenter, title: title, items: choices, selected: selected) { value in
                reply(["value": value as Any? ?? NSNull()], nil)
            }
        case "account":
            QuizNativeSheets.presentAccount(on: presenter, email: body["email"] as? String) { [weak self] action, email, password in
                guard let self else { return "账号服务暂不可用，请重试。" }
                return await self.performAccountAction(action, email: email, password: password)
            } completion: {
                reply(true, nil)
            }
        default:
            reply(nil, "Unknown native UI request.")
        }
    }

    private func performAccountAction(_ action: String, email: String, password: String) async -> String? {
        guard let webView else { return "账号服务暂不可用，请重试。" }
        do {
            let result = try await webView.callAsyncJavaScript(
                "return await window.QuizNativeAccount.run(action, email, password);",
                arguments: ["action": action, "email": email, "password": password], in: nil, contentWorld: .page
            )
            return result as? String
        } catch {
            return "账号服务暂不可用，请重试。"
        }
    }
}

@available(iOS 26.0, *)
private final class QuizNativeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var controller: QuizBridgeViewController?

    init(controller: QuizBridgeViewController) {
        self.controller = controller
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let controller else {
            replyHandler(nil, "Native UI is unavailable.")
            return
        }
        controller.handle(message, reply: replyHandler)
    }
}

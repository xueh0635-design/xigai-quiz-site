import UIKit

@available(iOS 26.0, *)
final class QuizNativeTabBarController: UITabBarController, UITabBarControllerDelegate {
    private struct StudyTab {
        let name: String
        let title: String
        let symbol: String
    }

    private let studyTabs = [
        StudyTab(name: "practice", title: "练习", symbol: "square.and.pencil"),
        StudyTab(name: "wrong", title: "错题", symbol: "xmark.circle"),
        StudyTab(name: "starred", title: "收藏", symbol: "star"),
        StudyTab(name: "profile", title: "我的", symbol: "person.crop.circle")
    ]

    private let content: UIViewController
    private var contentConstraints: [NSLayoutConstraint] = []
    var onTabSelected: ((String) -> Void)?

    init(content: UIViewController) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("QuizNativeTabBarController requires a content view controller")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        mode = .tabBar
        delegate = self
        let hosts = studyTabs.enumerated().map { index, tab in
            let host = UIViewController()
            host.tabBarItem = UITabBarItem(title: tab.title, image: UIImage(systemName: tab.symbol), tag: index)
            return host
        }
        setViewControllers(hosts, animated: false)
        if let selectedViewController {
            attachContent(to: selectedViewController)
        }
    }

    func selectTab(_ name: String) {
        guard let index = studyTabs.firstIndex(where: { $0.name == name }) else { return }
        loadViewIfNeeded()
        guard let host = viewControllers?[index] else { return }
        if selectedViewController !== host {
            selectedViewController = host
        }
        attachContent(to: host)
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        let index = viewController.tabBarItem.tag
        guard studyTabs.indices.contains(index) else { return }
        attachContent(to: viewController)
        onTabSelected?(studyTabs[index].name)
    }

    private func attachContent(to host: UIViewController) {
        guard content.parent !== host else { return }

        // Keep the Capacitor controller and its live web session across tab changes.
        if content.parent != nil {
            content.willMove(toParent: nil)
            NSLayoutConstraint.deactivate(contentConstraints)
            content.view.removeFromSuperview()
            content.removeFromParent()
        }

        host.addChild(content)
        let contentView = content.view!
        contentView.translatesAutoresizingMaskIntoConstraints = false
        host.view.addSubview(contentView)
        contentConstraints = [
            contentView.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: host.view.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: host.view.bottomAnchor)
        ]
        NSLayoutConstraint.activate(contentConstraints)
        content.didMove(toParent: host)
    }
}

import UIKit

@available(iOS 26.0, *)
final class QuizNativeTabBarController: UITabBarController, UITabBarControllerDelegate, UIGestureRecognizerDelegate {
    private struct StudyTab {
        let name: String
        let title: String
        let symbol: String
        let selectedSymbol: String
    }

    private let studyTabs = [
        StudyTab(name: "practice", title: "路线", symbol: "map", selectedSymbol: "map.fill"),
        StudyTab(name: "wrong", title: "错题", symbol: "xmark.circle", selectedSymbol: "xmark.circle.fill"),
        StudyTab(name: "desk", title: "一起学", symbol: "", selectedSymbol: ""),
        StudyTab(name: "starred", title: "收藏", symbol: "star", selectedSymbol: "star.fill"),
        StudyTab(name: "profile", title: "我的", symbol: "person.crop.circle", selectedSymbol: "person.crop.circle.fill")
    ]

    private let content: UIViewController
    private var contentConstraints: [NSLayoutConstraint] = []
    private let questionSwipeHorizontalRatio = 1.12
    private var questionSwipeStartedAt: TimeInterval = 0
    private lazy var questionSwipe = UIPanGestureRecognizer(target: self, action: #selector(finishQuestionSwipe))
    var onTabSelected: ((String) -> Void)?
    var onQuestionSwipe: ((Int) -> Void)?

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
            let sharedStudy = tab.name == "desk"
            let image = sharedStudy ? makeSharedStudyIcon(false) : UIImage(systemName: tab.symbol)
            let item = UITabBarItem(title: tab.title, image: image, tag: index)
            item.selectedImage = sharedStudy ? makeSharedStudyIcon(true) : UIImage(systemName: tab.selectedSymbol)
            host.tabBarItem = item
            return host
        }
        setViewControllers(hosts, animated: false)
        questionSwipe.isEnabled = false
        questionSwipe.maximumNumberOfTouches = 1
        questionSwipe.delegate = self
        // UIKit can host floating tab controls beside the tab bar itself.
        view.addGestureRecognizer(questionSwipe)
        if let selectedViewController {
            attachContent(to: selectedViewController)
        }
    }

    func setQuestionSwipeEnabled(_ enabled: Bool) {
        questionSwipe.isEnabled = enabled
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let location = touch.location(in: tabBar)
        guard presentedViewController == nil, tabBar.bounds.contains(location) else { return false }
        questionSwipeStartedAt = Date.now.timeIntervalSinceReferenceDate
        return true
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        let offset = questionSwipe.translation(in: tabBar)
        return abs(offset.x) >= abs(offset.y) * questionSwipeHorizontalRatio
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        guard let owner = other.view, !(other is UIScreenEdgePanGestureRecognizer) else { return false }
        return owner === view || owner.isDescendant(of: view)
    }

    @objc private func finishQuestionSwipe() {
        guard questionSwipe.state == .ended, presentedViewController == nil else { return }
        let offset = questionSwipe.translation(in: tabBar)
        let quick = Date.now.timeIntervalSinceReferenceDate - questionSwipeStartedAt <= 0.14
        let distance = abs(offset.x)
        guard distance >= (quick ? 10 : 16), distance >= abs(offset.y) * questionSwipeHorizontalRatio else { return }
        onQuestionSwipe?(offset.x < 0 ? 1 : -1)
    }

    private func makeSharedStudyIcon(_ selected: Bool) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 26, height: 26)).image { _ in
            let book = UIBezierPath()
            book.move(to: CGPoint(x: 4, y: 7))
            book.addQuadCurve(to: CGPoint(x: 11.5, y: 8), controlPoint: CGPoint(x: 7.5, y: 5.8))
            book.addLine(to: CGPoint(x: 11.5, y: 20))
            book.addQuadCurve(to: CGPoint(x: 4, y: 19), controlPoint: CGPoint(x: 7.5, y: 17.8))
            book.close()
            let rightPage = UIBezierPath(cgPath: book.cgPath)
            rightPage.apply(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 26, ty: 0))
            book.append(rightPage)
            book.lineWidth = selected ? 2.1 : 1.65
            book.lineJoinStyle = .round
            UIColor.black.setStroke()
            UIColor.black.setFill()
            book.stroke()

            let glint = UIBezierPath()
            glint.move(to: CGPoint(x: 13, y: 1))
            glint.addLine(to: CGPoint(x: 14.1, y: 3.4))
            glint.addLine(to: CGPoint(x: 16.5, y: 4.5))
            glint.addLine(to: CGPoint(x: 14.1, y: 5.6))
            glint.addLine(to: CGPoint(x: 13, y: 8))
            glint.addLine(to: CGPoint(x: 11.9, y: 5.6))
            glint.addLine(to: CGPoint(x: 9.5, y: 4.5))
            glint.addLine(to: CGPoint(x: 11.9, y: 3.4))
            glint.close()
            glint.fill()
        }.withRenderingMode(.alwaysTemplate)
    }

    func selectTab(_ name: String, animated: Bool) {
        guard let index = studyTabs.firstIndex(where: { $0.name == name }) else { return }
        loadViewIfNeeded()
        guard let host = viewControllers?[index] else { return }
        if selectedViewController !== host {
            if animated && !UIAccessibility.isReduceMotionEnabled {
                UIView.animate(withDuration: 0.26, delay: 0,
                               options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut]) {
                    self.selectedViewController = host
                    self.view.layoutIfNeeded()
                }
            } else {
                selectedViewController = host
            }
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
        // The live WebView animates its own page. Keep the host transfer in the same layout pass.
        UIView.performWithoutAnimation {
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
            host.view.layoutIfNeeded()
            content.didMove(toParent: host)
        }
    }
}

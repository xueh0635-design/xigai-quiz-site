import SwiftUI
import UIKit

struct QuizNativeChoice {
    let value: String
    let title: String
    let detail: String?
}

@available(iOS 26.0, *)
@MainActor
enum QuizNativeSheets {
    static func presentChoices(
        on presenter: UIViewController,
        title: String,
        items: [QuizNativeChoice],
        selected: String,
        completion: @escaping (String?) -> Void
    ) {
        let sheet = QuizSheetPresentation(completion: completion)
        let content = QuizChoicesContent(items: items, selected: selected, select: sheet.dismiss)
        sheet.present(on: presenter, title: title, content: content)
    }

    static func presentAccount(
        on presenter: UIViewController,
        email: String?,
        perform: @escaping @MainActor (String, String, String) async -> String?,
        completion: @escaping () -> Void
    ) {
        let sheet = QuizSheetPresentation<String> { _ in completion() }
        let content = QuizAccountContent(
            accountEmail: email,
            perform: perform,
            setBusy: sheet.setBusy,
            close: sheet.cancel
        )
        sheet.present(on: presenter, title: email == nil ? "账号登录" : "学习账号", content: content)
    }
}

@available(iOS 26.0, *)
@MainActor
private final class QuizSheetPresentation<Value>: NSObject, UISheetPresentationControllerDelegate {
    private var completion: ((Value?) -> Void)?
    private weak var navigation: UINavigationController?
    private weak var closeButton: UIBarButtonItem?
    private var dismissing = false

    init(completion: @escaping (Value?) -> Void) {
        self.completion = completion
    }

    func present<Content: View>(on presenter: UIViewController, title: String, content: Content) {
        guard presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
            finish(nil)
            return
        }

        let host = UIHostingController(rootView: content)
        host.view.backgroundColor = .clear
        host.view.isOpaque = false
        host.navigationItem.title = title
        let closeButton = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.cancel() }
        )
        closeButton.accessibilityLabel = "关闭"
        host.navigationItem.rightBarButtonItem = closeButton

        let navigation = UINavigationController(rootViewController: host)
        navigation.modalPresentationStyle = .pageSheet
        if let controller = navigation.sheetPresentationController {
            controller.detents = [.medium(), .large()]
            controller.selectedDetentIdentifier = .medium
            controller.prefersGrabberVisible = true
            controller.delegate = self
        }
        self.navigation = navigation
        self.closeButton = closeButton
        presenter.present(navigation, animated: true)
    }

    func setBusy(_ busy: Bool) {
        navigation?.isModalInPresentation = busy
        closeButton?.isEnabled = !busy
    }

    func cancel() {
        dismiss(nil)
    }

    func dismiss(_ value: Value?) {
        guard let navigation, !dismissing, completion != nil else { return }
        dismissing = true
        navigation.dismiss(animated: true) { [self] in finish(value) }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if !dismissing { finish(nil) }
    }

    private func finish(_ value: Value?) {
        let callback = completion
        completion = nil
        callback?(value)
    }
}

@available(iOS 26.0, *)
private struct QuizChoicesContent: View {
    let items: [QuizNativeChoice]
    let selected: String
    let select: (String) -> Void

    var body: some View {
        ScrollViewReader { scrollView in
            List(items, id: \.value) { item in
                choiceRow(item)
                    .id(item.value)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .onAppear {
                scrollView.scrollTo(selected, anchor: .center)
            }
        }
    }

    private func choiceRow(_ item: QuizNativeChoice) -> some View {
        let isSelected = item.value == selected
        return Button {
            select(item.value)
        } label: {
            HStack(spacing: 12) {
                Text(item.title)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                if let detail = item.detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if isSelected {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .listRowBackground(Color.clear)
    }
}

@available(iOS 26.0, *)
private struct QuizAccountContent: View {
    private enum Field: Hashable {
        case email, password
    }

    let accountEmail: String?
    let perform: @MainActor (String, String, String) async -> String?
    let setBusy: (Bool) -> Void
    let close: () -> Void

    @State private var registering = false
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var message: String?
    @FocusState private var focus: Field?

    private var cleanEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let accountEmail {
                    accountActions(accountEmail)
                } else {
                    loginFields
                }
                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var loginFields: some View {
        Group {
            TextField("邮箱", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .email)
                .submitLabel(.next)
                .onSubmit { focus = .password }
            SecureField(registering ? "密码（至少 10 个字符）" : "密码", text: $password)
                .textContentType(registering ? .newPassword : .password)
                .focused($focus, equals: .password)
                .submitLabel(.go)
                .onSubmit(submit)
            Button(action: submit) {
                Text(registering ? "创建并登录" : "登录")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .disabled(cleanEmail.isEmpty || password.isEmpty)
            Button(registering ? "返回登录" : "注册账号") {
                registering.toggle()
                password = ""
                message = nil
            }
            .buttonStyle(.glass)
        }
        .textFieldStyle(.roundedBorder)
        .disabled(busy)
    }

    private func accountActions(_ accountEmail: String) -> some View {
        Group {
            Text(accountEmail)
                .font(.headline)
                .textSelection(.enabled)
            Button {
                run("refresh", progress: "正在同步…")
            } label: {
                Label("同步学习进度", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            Button(role: .destructive) {
                run("logout", progress: "正在退出登录…")
            } label: {
                Text("退出登录")
            }
            .buttonStyle(.glass)
        }
        .disabled(busy)
    }

    private func submit() {
        guard !cleanEmail.isEmpty, !password.isEmpty else { return }
        guard !registering || password.utf16.count >= 10 else {
            message = "密码至少需要 10 个字符。"
            return
        }
        focus = nil
        run(registering ? "register" : "login", progress: registering ? "正在注册…" : "正在登录…")
    }

    private func run(_ action: String, progress: String) {
        guard !busy else { return }
        busy = true
        setBusy(true)
        message = progress
        Task { @MainActor in
            let error = await perform(action, cleanEmail, password)
            busy = false
            setBusy(false)
            if let error {
                message = error
            } else if action == "refresh" {
                message = "已请求同步。"
            } else {
                password = ""
                close()
            }
        }
    }
}

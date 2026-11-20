const { copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

// Use the Xcode project parser already installed by the Capacitor CLI.
const requireFromCapacitor = createRequire(require.resolve("@capacitor/cli/package.json"));
const xcode = requireFromCapacitor("xcode");
const plist = requireFromCapacitor("plist");
const appDirectory = join(__dirname, "..", "ios", "App");
const projectFile = join(appDirectory, "App.xcodeproj", "project.pbxproj");
const project = xcode.project(projectFile).parseSync();
const appGroup = project.findPBXGroupKey({ path: "App" });
const appTarget = project.getFirstTarget().uuid;
if (!appGroup || !project.hasFile("SceneDelegate.swift")) {
  throw new Error("Expected a Capacitor iOS project with a SceneDelegate in its App target");
}

const sources = [
  "SceneDelegate.swift",
  "QuizBridgeViewController.swift",
  "QuizNativeSheets.swift",
  "QuizNativeTabBarController.swift",
];

for (const source of sources) {
  if (!project.hasFile(source)) {
    project.addSourceFile(source, { target: appTarget }, appGroup);
  }
  copyFileSync(join(__dirname, source), join(appDirectory, "App", source));
}
writeFileSync(projectFile, project.writeSync());

const infoFile = join(appDirectory, "App", "Info.plist");
const info = plist.parse(readFileSync(infoFile, "utf8"));
info.NSMicrophoneUsageDescription = "在对局中主动开麦时，允许同场玩家听到你的声音。";
delete info.UILaunchStoryboardName;
info.UILaunchScreen = { UIColorName: "LaunchBackground", UIImageName: "Splash", UIImageRespectsSafeAreaInsets: false };
writeFileSync(infoFile, plist.build(info));

const catalog = join(appDirectory, "App", "Assets.xcassets");
const splash = join(catalog, "Splash.imageset");
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  rmSync(join(splash, name), { force: true });
}
for (const asset of ["LaunchBackground.colorset", "Splash.imageset"]) {
  cpSync(join(__dirname, "Assets.xcassets", asset), join(catalog, asset), { recursive: true });
}

// monorepo 支撑：@tau/* 经 file: 符号链接指向 ../../packages，且是纯 TS 源码包
// （package.json 只有 "exports" 指向 src/index.ts）。metro 需要 watch 仓库根、
// 解析根 node_modules，并启用 package exports 才能吃到 TS 入口。
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(root, "node_modules")];
config.resolver.extraNodeModules = {
	"@tau/kernel": path.resolve(root, "packages/kernel"),
	"@tau/host-rn": path.resolve(root, "packages/host-rn"),
};
config.resolver.unstable_enablePackageExports = true;
module.exports = config;

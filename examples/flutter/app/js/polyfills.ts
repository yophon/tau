// 引擎缺口补丁（宿主层职责，同 Platform 注入哲学）：flutter_js 内置的 QuickJS
// 版本偏旧，缺若干 ES2022+ 内置方法；内核以干净 ES2022 编写，这里在内核加载前
// 逐个补齐（全部 guarded——引擎已有则不覆盖，零风险）。
// 引擎选型 spike 实测缺失项（Android/flutter_js，2026-07-16）：Array/String.prototype.at。
// 其余为预防性补齐，防后续代码路径踩雷。
type AnyArray = unknown[];

function define(target: object, name: string, value: unknown): void {
	if (!(name in target)) {
		Object.defineProperty(target, name, { value, writable: true, configurable: true });
	}
}

// Array.prototype.at / String.prototype.at（ES2022）
define(Array.prototype, "at", function (this: AnyArray, index: number): unknown {
	const len = this.length;
	const i = index < 0 ? len + index : index;
	return i >= 0 && i < len ? this[i] : undefined;
});
define(String.prototype, "at", function (this: string, index: number): string | undefined {
	const len = this.length;
	const i = index < 0 ? len + index : index;
	return i >= 0 && i < len ? this[i] : undefined;
});

// Object.hasOwn（ES2022）——local alias 躲开 biome 的 useObjectHasOwn 重写
// （否则 polyfill 体会被改成自引用 Object.hasOwn → 引擎真缺时无限递归）。
const rawHasOwnProperty = Object.prototype.hasOwnProperty;
define(Object, "hasOwn", (obj: object, key: PropertyKey): boolean => rawHasOwnProperty.call(obj, key));

// Array.prototype.findLast / findLastIndex（ES2023）
define(
	Array.prototype,
	"findLastIndex",
	function (this: AnyArray, predicate: (value: unknown, index: number, array: AnyArray) => boolean): number {
		for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return i;
		return -1;
	},
);
define(
	Array.prototype,
	"findLast",
	function (this: AnyArray, predicate: (value: unknown, index: number, array: AnyArray) => boolean): unknown {
		for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return this[i];
		return undefined;
	},
);

// String.prototype.replaceAll（ES2021）——会话路径用（Flutter v1 无 fs，预防性）
define(String.prototype, "replaceAll", function (this: string, search: string, replacement: string): string {
	return this.split(search).join(replacement);
});

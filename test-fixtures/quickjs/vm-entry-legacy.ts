// 老引擎门禁 fixture（P17）：polyfills 前置 + 标准两轮 agent 循环。
// 与 flutter bundle（examples/flutter/app/js/tau-entry.ts）引用同一份 polyfills.ts——单源化，
// 防 polyfill 清单在两处静默失配。smoke:quickjs:legacy 同时会跑无 polyfill 的 vm-entry.ts
// 断言其在老引擎上按预期失败（内核热路径用 .at(-1)），双态成立门禁才算数。
import "./polyfills.ts";
import "./vm-entry.ts";

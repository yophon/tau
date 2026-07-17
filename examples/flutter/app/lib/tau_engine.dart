// TauEngine：flutter_js 引擎封装。加载 assets/tau.js（内核 + mcp-http + guard），
// 泵微任务，把 Dart↔JS 消息通道封装成事件流。Platform 桥在 Dart 侧实现（HTTP 流式、
// sleep、randomBytes、UI 确认），JS 侧经 __tau 注入调用。
//
// flutter_js 运行模型：evaluate() 同步入 JS；JS 经 sendMessage(channel, json) 回调
// Dart（onMessage）；async 结果经 __tau.resolveXxx(id, ...) 回送。微任务由
// flutter_js 在每次 evaluate 后自动泵（QuickJS executePendingJobs / JSC 原生）。
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_js/flutter_js.dart';
import 'package:http/http.dart' as http;

typedef ApprovalHandler = Future<bool> Function(String title, String message);

class TauEngine {
  TauEngine();

  late final JavascriptRuntime _rt;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _httpClient = http.Client();
  final _inflight = <int, StreamSubscription<List<int>>>{};
  final _sleepTimers = <int, Timer>{};
  final _random = Random.secure();
  ApprovalHandler? onApproval;
  bool _ready = false;

  Stream<Map<String, dynamic>> get events => _events.stream;
  bool get isReady => _ready;

  Future<void> start() async {
    _rt = getJavascriptRuntime(xhr: false);
    _wireChannels();
    final code = await rootBundle.loadString('assets/tau.js');
    final result = _rt.evaluate(code);
    if (result.isError) {
      throw StateError('tau.js failed to load: ${result.stringResult}');
    }
    _rt.executePendingJob();
  }

  // flutter_js 的 onMessage 通道会把 JS 传来的 JSON 字符串预先 jsonDecode（引擎选型
  // spike 实测差异，2026-07-16）——payload 已是 Map；非 JSON 时才是原始 String。
  Map<String, dynamic> _asMap(dynamic payload) =>
      payload is String ? jsonDecode(payload) as Map<String, dynamic> : (payload as Map).cast<String, dynamic>();

  void _wireChannels() {
    _rt.onMessage('tau_event', (dynamic payload) {
      final map = _asMap(payload);
      if (map['type'] == 'ready') _ready = true;
      _events.add(map);
    });
    _rt.onMessage('tau_http', (dynamic payload) {
      _handleHttp(_asMap(payload));
    });
    _rt.onMessage('tau_sleep', (dynamic payload) {
      _handleSleep(_asMap(payload));
    });
    _rt.onMessage('tau_ui', (dynamic payload) {
      _handleUi(_asMap(payload));
    });
  }

  // ---- Dart→JS：evaluate 调用 __tau.* ----
  void _call(String expression) {
    final result = _rt.evaluate(expression);
    if (result.isError) {
      _events.add({'type': 'error', 'message': 'JS call failed: ${result.stringResult}'});
    }
    _rt.executePendingJob();
  }

  String _js(String value) => jsonEncode(value);

  void configure({
    required String baseUrl,
    String? apiKey,
    required String model,
    String? mcpUrl,
    String? mcpToken,
    int? stallTimeoutMs,
  }) {
    final config = <String, dynamic>{
      'baseUrl': baseUrl,
      'apiKey': apiKey,
      'model': model,
      'mcpUrl': mcpUrl,
      'mcpToken': mcpToken,
      'stallTimeoutMs': stallTimeoutMs,
    }..removeWhere((_, value) => value == null);
    // Seed entropy for uuidv7 randomBytes (best-effort; JS falls back if drained).
    final entropy = List<int>.generate(256, (_) => _random.nextInt(256));
    _call('globalThis.__ENTROPY = ${jsonEncode(entropy)};');
    _call('__tau.configure(${_js(jsonEncode(config))});');
  }

  void connect() => _call('__tau.connect();');
  void prompt(String text) => _call('__tau.prompt(${_js(text)});');
  void steer(String text) => _call('__tau.steer(${_js(text)});');
  void abort() => _call('__tau.abort();');

  // ---- HTTP 桥：Dart 执行流式请求，chunk 经 base64 回送 JS ----
  Future<void> _handleHttp(Map<String, dynamic> msg) async {
    final id = msg['id'] as int;
    if (msg['op'] == 'abort') {
      await _inflight.remove(id)?.cancel();
      return;
    }
    final url = msg['url'] as String;
    final method = msg['method'] as String? ?? 'GET';
    final headers = (msg['headers'] as Map?)?.cast<String, String>() ?? const {};
    final body = msg['body'] as String?;
    try {
      final request = http.Request(method, Uri.parse(url));
      request.headers.addAll(headers);
      if (body != null) request.body = body;
      final response = await _httpClient.send(request);
      _resolveHttp(id, 'response', {
        'status': response.statusCode,
        'headers': response.headers,
      });
      final sub = response.stream.listen(
        (chunk) => _resolveHttp(id, 'chunk', {'b64': base64Encode(chunk)}),
        onError: (Object error) {
          _inflight.remove(id);
          _resolveHttp(id, 'error', {'message': error.toString()});
        },
        onDone: () {
          _inflight.remove(id);
          _resolveHttp(id, 'end', {});
        },
        cancelOnError: true,
      );
      _inflight[id] = sub;
    } catch (error) {
      _resolveHttp(id, 'error', {'message': error.toString()});
    }
  }

  void _resolveHttp(int id, String kind, Map<String, dynamic> payload) {
    _call('__tau.resolveHttp($id, ${_js(kind)}, ${_js(jsonEncode(payload))});');
  }

  // ---- sleep 桥（Dart Timer）----
  void _handleSleep(Map<String, dynamic> msg) {
    final id = msg['id'] as int;
    if (msg['op'] == 'cancel') {
      _sleepTimers.remove(id)?.cancel();
      return;
    }
    final ms = msg['ms'] as int;
    _sleepTimers[id] = Timer(Duration(milliseconds: ms), () {
      _sleepTimers.remove(id);
      _call('__tau.resolveSleep($id);');
    });
  }

  // ---- UI 桥（审批弹窗 / notify）----
  Future<void> _handleUi(Map<String, dynamic> msg) async {
    if (msg['op'] == 'notify') {
      _events.add({'type': 'notify', 'message': msg['message'], 'level': msg['level']});
      return;
    }
    if (msg['op'] == 'confirm') {
      final id = msg['id'] as int;
      final ok = await (onApproval?.call(msg['title'] as String, msg['message'] as String? ?? '') ??
          Future<bool>.value(false));
      _call('__tau.resolveUi($id, $ok);');
    }
  }

  void dispose() {
    for (final sub in _inflight.values) {
      sub.cancel();
    }
    for (final timer in _sleepTimers.values) {
      timer.cancel();
    }
    _httpClient.close();
    _events.close();
    _rt.dispose();
  }
}

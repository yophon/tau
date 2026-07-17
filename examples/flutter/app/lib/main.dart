// tau Flutter demo：手机上的 agent 本体，工具经 MCP 连电脑侧。
// 两页——设置（LLM + MCP 配置）、聊天（流式文本 + 工具卡片 + 审批弹窗）。
import 'package:flutter/material.dart';

import 'chat_page.dart';
import 'settings.dart';
import 'tau_engine.dart';

void main() {
  runApp(const TauApp());
}

class TauApp extends StatefulWidget {
  const TauApp({super.key});

  @override
  State<TauApp> createState() => _TauAppState();
}

class _TauAppState extends State<TauApp> {
  final TauEngine _engine = TauEngine();
  Settings? _settings;
  String? _startupError;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    try {
      final settings = await Settings.load();
      await _engine.start();
      setState(() => _settings = settings);
    } catch (error) {
      setState(() => _startupError = error.toString());
    }
  }

  @override
  void dispose() {
    _engine.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'tau',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true, brightness: Brightness.dark),
      home: _buildHome(),
    );
  }

  Widget _buildHome() {
    if (_startupError != null) {
      return Scaffold(body: Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('启动失败：$_startupError'))));
    }
    final settings = _settings;
    if (settings == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return ChatPage(engine: _engine, settings: settings);
  }
}

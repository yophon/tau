import 'dart:async';

import 'package:flutter/material.dart';

import 'settings.dart';
import 'settings_page.dart';
import 'tau_engine.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.engine, required this.settings});

  final TauEngine engine;
  final Settings settings;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

/// 一条聊天记录：user / assistant 文本，或一个工具调用卡片。
class _Entry {
  _Entry.user(this.text)
      : role = 'user',
        toolName = null;
  _Entry.assistant()
      : role = 'assistant',
        text = '',
        toolName = null;
  _Entry.tool(this.toolName)
      : role = 'tool',
        text = '';

  final String role;
  String? text;
  final String? toolName;
  String? toolOutput;
  bool toolError = false;
  bool expanded = false;
}

class _ChatPageState extends State<ChatPage> {
  final _entries = <_Entry>[];
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _sub;
  _Entry? _streaming;
  bool _running = false;
  String _mcpState = 'connecting';
  int _toolCount = 0;
  String? _mcpError;

  @override
  void initState() {
    super.initState();
    _sub = widget.engine.events.listen(_onEvent);
    widget.engine.onApproval = _askApproval;
    _configureAndConnect();
  }

  void _configureAndConnect() {
    final s = widget.settings;
    widget.engine.configure(
      baseUrl: s.baseUrl,
      apiKey: s.apiKey.isEmpty ? null : s.apiKey,
      model: s.model,
      mcpUrl: s.mcpUrl.isEmpty ? null : s.mcpUrl,
      mcpToken: s.mcpToken.isEmpty ? null : s.mcpToken,
    );
    if (s.mcpUrl.isEmpty) {
      setState(() {
        _mcpState = 'offline';
        _mcpError = '未配置 MCP server';
      });
    } else {
      setState(() {
        _mcpState = 'connecting';
        _mcpError = null;
      });
      widget.engine.connect();
    }
  }

  Future<bool> _askApproval(String title, String message) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(child: Text(message)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('拒绝')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('允许')),
        ],
      ),
    );
    return result ?? false;
  }

  void _onEvent(Map<String, dynamic> event) {
    setState(() {
      switch (event['type']) {
        case 'text_delta':
          _streaming ??= _appendAssistant();
          _streaming!.text = (_streaming!.text ?? '') + (event['delta'] as String);
        case 'tool_start':
          _streaming = null;
          _entries.add(_Entry.tool(event['name'] as String)..text = _stringify(event['input']));
        case 'tool_result':
          final name = event['name'] as String;
          final entry = _entries.lastWhere((e) => e.role == 'tool' && e.toolName == name, orElse: () => _entries.last);
          entry.toolOutput = event['output'] as String?;
          entry.toolError = event['isError'] == true;
        case 'assistant_message':
          if (event['stopReason'] == 'error' || event['stopReason'] == 'aborted') {
            _appendAssistant().text = '⚠ ${event['stopReason']}: ${event['error'] ?? ''}';
          }
          _streaming = null;
        case 'agent_end':
          _running = false;
          _streaming = null;
        case 'error':
          _appendAssistant().text = '⚠ ${event['message']}';
          _running = false;
        case 'mcp_status':
          final status = event['status'] as Map<String, dynamic>;
          _mcpState = status['state'] as String;
          _toolCount = status['toolCount'] as int? ?? _toolCount;
          _mcpError = status['error'] as String?;
      }
    });
    _autoScroll();
  }

  _Entry _appendAssistant() {
    final entry = _Entry.assistant();
    _entries.add(entry);
    return entry;
  }

  String _stringify(dynamic value) => value == null ? '' : value.toString();

  void _autoScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    _input.clear();
    setState(() {
      _entries.add(_Entry.user(text));
      _streaming = null;
      if (_running) {
        widget.engine.steer(text);
      } else {
        _running = true;
        widget.engine.prompt(text);
      }
    });
    _autoScroll();
  }

  Future<void> _openSettings() async {
    final changed = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (context) => SettingsPage(settings: widget.settings)),
    );
    if (changed == true) _configureAndConnect();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('tau'),
        bottom: PreferredSize(preferredSize: const Size.fromHeight(28), child: _statusBar()),
        actions: [IconButton(onPressed: _openSettings, icon: const Icon(Icons.settings))],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(12),
              itemCount: _entries.length,
              itemBuilder: (context, index) => _entryWidget(_entries[index]),
            ),
          ),
          _composer(),
        ],
      ),
    );
  }

  Widget _statusBar() {
    final (color, label) = switch (_mcpState) {
      'connected' => (Colors.greenAccent, '电脑已连接 · $_toolCount 个工具'),
      'connecting' => (Colors.amberAccent, '连接电脑中…'),
      _ => (Colors.redAccent, '电脑离线${_mcpError != null ? '（$_mcpError）' : ''}'),
    };
    return Container(
      height: 28,
      color: Colors.black26,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          Icon(Icons.circle, size: 10, color: color),
          const SizedBox(width: 6),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis)),
          if (_mcpState != 'connected')
            TextButton(onPressed: _configureAndConnect, child: const Text('重连', style: TextStyle(fontSize: 12))),
        ],
      ),
    );
  }

  Widget _entryWidget(_Entry entry) {
    if (entry.role == 'tool') return _toolCard(entry);
    final isUser = entry.role == 'user';
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
        decoration: BoxDecoration(
          color: isUser ? Colors.indigo : Colors.grey.shade800,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(entry.text ?? ''),
      ),
    );
  }

  Widget _toolCard(_Entry entry) {
    return Card(
      color: entry.toolError ? Colors.red.shade900 : Colors.blueGrey.shade900,
      child: ExpansionTile(
        leading: Icon(entry.toolError ? Icons.error_outline : Icons.build, size: 20),
        title: Text(entry.toolName ?? 'tool', style: const TextStyle(fontSize: 14)),
        subtitle: entry.toolOutput == null ? const Text('执行中…', style: TextStyle(fontSize: 12)) : null,
        childrenPadding: const EdgeInsets.all(12),
        children: [
          if (entry.text?.isNotEmpty == true)
            Align(alignment: Alignment.centerLeft, child: Text('参数：${entry.text}', style: const TextStyle(fontSize: 12))),
          if (entry.toolOutput != null)
            Align(alignment: Alignment.centerLeft, child: Text(entry.toolOutput!, style: const TextStyle(fontSize: 12))),
        ],
      ),
    );
  }

  Widget _composer() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _input,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _send(),
                decoration: InputDecoration(
                  hintText: _running ? '运行中（输入即插队 steering）…' : '给 agent 发消息…',
                  border: const OutlineInputBorder(),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (_running)
              IconButton.filled(onPressed: widget.engine.abort, icon: const Icon(Icons.stop))
            else
              IconButton.filled(onPressed: _send, icon: const Icon(Icons.send)),
          ],
        ),
      ),
    );
  }
}

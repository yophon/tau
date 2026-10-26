import 'package:flutter/material.dart';

import 'settings.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.settings});

  final Settings settings;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final TextEditingController _baseUrl;
  late final TextEditingController _apiKey;
  late final TextEditingController _model;
  late final TextEditingController _mcpUrl;
  late final TextEditingController _mcpToken;

  @override
  void initState() {
    super.initState();
    _baseUrl = TextEditingController(text: widget.settings.baseUrl);
    _apiKey = TextEditingController(text: widget.settings.apiKey);
    _model = TextEditingController(text: widget.settings.model);
    _mcpUrl = TextEditingController(text: widget.settings.mcpUrl);
    _mcpToken = TextEditingController(text: widget.settings.mcpToken);
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _apiKey.dispose();
    _model.dispose();
    _mcpUrl.dispose();
    _mcpToken.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    widget.settings
      ..baseUrl = _baseUrl.text.trim()
      ..apiKey = _apiKey.text.trim()
      ..model = _model.text.trim()
      ..mcpUrl = _mcpUrl.text.trim()
      ..mcpToken = _mcpToken.text.trim();
    await widget.settings.save();
    if (mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('设置'), actions: [IconButton(onPressed: _save, icon: const Icon(Icons.check))]),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _section('LLM（BYOK，直连手机网络）'),
          _field(_baseUrl, 'Base URL', 'https://api.openai.com/v1'),
          _field(_apiKey, 'API Key', 'sk-...', obscure: true),
          _field(_model, 'Model', 'gpt-4o-mini'),
          const SizedBox(height: 24),
          _section('MCP 工具端（电脑侧，局域网）'),
          _field(_mcpUrl, 'Server URL', 'http://192.168.x.x:8720/'),
          _field(_mcpToken, 'Token', 'bearer token', obscure: true),
          const SizedBox(height: 16),
          const Text(
            '⚠ Key 与 token 以明文存储在本机。run_command 是远程代码执行——仅在可信局域网使用。',
            style: TextStyle(fontSize: 12, color: Colors.orangeAccent),
          ),
        ],
      ),
    );
  }

  Widget _section(String title) =>
      Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)));

  Widget _field(TextEditingController controller, String label, String hint, {bool obscure = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(
          controller: controller,
          obscureText: obscure,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(labelText: label, hintText: hint, border: const OutlineInputBorder()),
        ),
      );
}

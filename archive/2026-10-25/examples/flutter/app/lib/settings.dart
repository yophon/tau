// 设置持久化（shared_preferences，明文——demo 定位，见 README 安全段）。
import 'package:shared_preferences/shared_preferences.dart';

class Settings {
  Settings({
    this.baseUrl = 'https://api.openai.com/v1',
    this.apiKey = '',
    this.model = 'gpt-4o-mini',
    this.mcpUrl = '',
    this.mcpToken = '',
  });

  String baseUrl;
  String apiKey;
  String model;
  String mcpUrl;
  String mcpToken;

  static Future<Settings> load() async {
    final prefs = await SharedPreferences.getInstance();
    return Settings(
      baseUrl: prefs.getString('baseUrl') ?? 'https://api.openai.com/v1',
      apiKey: prefs.getString('apiKey') ?? '',
      model: prefs.getString('model') ?? 'gpt-4o-mini',
      mcpUrl: prefs.getString('mcpUrl') ?? '',
      mcpToken: prefs.getString('mcpToken') ?? '',
    );
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('baseUrl', baseUrl);
    await prefs.setString('apiKey', apiKey);
    await prefs.setString('model', model);
    await prefs.setString('mcpUrl', mcpUrl);
    await prefs.setString('mcpToken', mcpToken);
  }
}

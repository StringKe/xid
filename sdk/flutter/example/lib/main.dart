import 'package:flutter/material.dart';
import 'package:xid/xid.dart';

/// 最小集成示例。
///
/// 前置:
///   1. 在 XID Console 创建 Application,类型选 Native,
///      填写 Redirect URI: com.example.myapp://auth/callback。
///   2. 在 AndroidManifest.xml 注册 intent-filter(App Links 或 custom scheme)。
///   3. 在 iOS Info.plist 注册 CFBundleURLTypes 或 Associated Domains。
void main() {
  runApp(const MyApp());
}

final xidClient = XidClient();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'XID Example',
      home: HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  XidSession? _session;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await xidClient.configure(
      const XidOptions(
        // 托管版填 https://xid.dev,自托管填部署根域。
        issuer: 'https://xid.dev',
        clientId: 'YOUR_CLIENT_ID',
        redirectUri: 'com.example.myapp://auth/callback',
        postLogoutRedirectUri: 'com.example.myapp://auth/callback',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      ),
    );

    // 恢复已有 session
    final session = await xidClient.getSession();
    if (mounted) setState(() => _session = session);
  }

  Future<void> _signIn() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final session = await xidClient.signIn();
      setState(() => _session = session);
    } on XidException catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _signOut() async {
    setState(() => _loading = true);
    try {
      await xidClient.signOut();
      setState(() => _session = null);
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('XID Example')),
      body: Center(
        child: _loading
            ? const CircularProgressIndicator()
            : _session == null
                ? Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_error != null)
                        Text(_error!, style: const TextStyle(color: Colors.red)),
                      ElevatedButton(
                        onPressed: _signIn,
                        child: const Text('Sign In'),
                      ),
                    ],
                  )
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Signed in as: ${_session!.user.email ?? _session!.user.id}'),
                      const SizedBox(height: 16),
                      ElevatedButton(
                        onPressed: _signOut,
                        child: const Text('Sign Out'),
                      ),
                    ],
                  ),
      ),
    );
  }
}

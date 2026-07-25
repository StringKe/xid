// 填充 page-seo msg 的各 locale 翻译。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../..', import.meta.url).pathname
const LOCALES = ['zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR']

const CJK = {
  'zh-Hans': {
    suffix: { docs: 'XID 文档', console: '控制台 | XID', account: '账户 | XID', plain: 'XID' },
    words: {
      'XID | Edge identity platform': 'XID | 边缘身份平台',
      'Developer docs': '开发者文档',
      'Page not found': '页面未找到',
      'Sign in': '登录',
      'Sign up': '注册',
      'Reset password': '重置密码',
      'Two-factor authentication': '双因素认证',
      'Verify email': '验证邮箱',
      'Accept invitation': '接受邀请',
      'Create organization': '创建组织',
      'Select organization': '选择组织',
      'Authorize application': '授权应用',
      'Activate device': '激活设备',
      'Approve sign-in request': '批准登录请求',
      Profile: '个人资料',
      Security: '安全',
      Connections: '关联账户',
      Sessions: '会话',
      'Trusted devices': '受信设备',
      'Console overview': '控制台概览',
      Users: '用户',
      Organizations: '组织',
      Settings: '设置',
      'Organization overview': '组织概览',
      Members: '成员',
      Roles: '角色',
      'Auth policy': '认证策略',
      'Delivery channels': '投递渠道',
      'Social providers': '社交登录提供商',
      'Inbound enterprise SSO': '入站企业 SSO',
      'Outbound enterprise SSO': '出站企业 SSO',
      'Directory sync': '目录同步',
      'SCIM targets': 'SCIM 目标',
      Domains: '域名',
      Branding: '品牌',
      'OAuth applications': 'OAuth 应用',
      Webhooks: 'Webhook',
      'API keys': 'API 密钥',
      'Audit events': '审计事件',
      'Platform overview': '平台概览',
      'Platform organizations': '平台组织',
      'Platform users': '平台用户',
      'Event stream': '事件流',
      'Feature flags': '功能开关',
      'Billing overview': '计费概览',
      'Platform settings': '平台设置',
      'Getting started': '入门',
      'Hosted Auth': '托管认证',
      'OIDC and OAuth': 'OIDC 与 OAuth',
      'Enterprise SSO': '企业 SSO',
      'Social login': '社交登录',
      'Management API': '管理 API',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDK',
      'Self-hosting': '自托管',
    },
    descriptions: {
      home: 'XID 是面向 Cloudflare 的边缘原生身份平台,提供 OIDC、OAuth、组织 RBAC、企业 SSO、SCIM、通行密钥与无网络 JWT 校验。',
      docs: 'XID 的 OIDC、托管认证、企业 SSO、SCIM、SAML、管理 API、Webhook、品牌与 SDK 集成技术文档。',
    },
  },
  ja: {
    suffix: {
      docs: 'XID ドキュメント',
      console: 'コンソール | XID',
      account: 'アカウント | XID',
      plain: 'XID',
    },
    words: {
      'XID | Edge identity platform': 'XID | エッジ ID プラットフォーム',
      'Developer docs': '開発者ドキュメント',
      'Page not found': 'ページが見つかりません',
      'Sign in': 'サインイン',
      'Sign up': 'サインアップ',
      'Reset password': 'パスワード再設定',
      'Two-factor authentication': '二要素認証',
      'Verify email': 'メール確認',
      'Accept invitation': '招待を承諾',
      'Create organization': '組織を作成',
      'Select organization': '組織を選択',
      'Authorize application': 'アプリを承認',
      'Activate device': 'デバイスを有効化',
      'Approve sign-in request': 'サインイン要求を承認',
      Profile: 'プロフィール',
      Security: 'セキュリティ',
      Connections: '連携',
      Sessions: 'セッション',
      'Trusted devices': '信頼済みデバイス',
      'Console overview': 'コンソール概要',
      Users: 'ユーザー',
      Organizations: '組織',
      Settings: '設定',
      'Organization overview': '組織概要',
      Members: 'メンバー',
      Roles: 'ロール',
      'Auth policy': '認証ポリシー',
      'Delivery channels': '配信チャネル',
      'Social providers': 'ソーシャルプロバイダー',
      'Inbound enterprise SSO': 'インバウンド企業 SSO',
      'Outbound enterprise SSO': 'アウトバウンド企業 SSO',
      'Directory sync': 'ディレクトリ同期',
      'SCIM targets': 'SCIM ターゲット',
      Domains: 'ドメイン',
      Branding: 'ブランディング',
      'OAuth applications': 'OAuth アプリ',
      Webhooks: 'Webhook',
      'API keys': 'API キー',
      'Audit events': '監査イベント',
      'Platform overview': 'プラットフォーム概要',
      'Platform organizations': 'プラットフォーム組織',
      'Platform users': 'プラットフォームユーザー',
      'Event stream': 'イベントストリーム',
      'Feature flags': '機能フラグ',
      'Billing overview': '請求概要',
      'Platform settings': 'プラットフォーム設定',
      'Getting started': 'はじめに',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC と OAuth',
      'Enterprise SSO': 'エンタープライズ SSO',
      'Social login': 'ソーシャルログイン',
      'Management API': 'Management API',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDK',
      'Self-hosting': 'セルフホスティング',
    },
    descriptions: {
      home: 'XID は Cloudflare 上で OIDC、OAuth、組織 RBAC、エンタープライズ SSO、SCIM、パスキー、ネットワークレス JWT 検証を提供するエッジネイティブ ID プラットフォームです。',
      docs: 'XID の OIDC、Hosted Auth、エンタープライズ SSO、SCIM、SAML、Management API、Webhook、ブランディング、SDK 連携の技術ドキュメントです。',
    },
  },
  ko: {
    suffix: { docs: 'XID 문서', console: '콘솔 | XID', account: '계정 | XID', plain: 'XID' },
    words: {
      'XID | Edge identity platform': 'XID | 엣지 ID 플랫폼',
      'Developer docs': '개발자 문서',
      'Page not found': '페이지를 찾을 수 없음',
      'Sign in': '로그인',
      'Sign up': '가입',
      'Reset password': '비밀번호 재설정',
      'Two-factor authentication': '이중 인증',
      'Verify email': '이메일 인증',
      'Accept invitation': '초대 수락',
      'Create organization': '조직 만들기',
      'Select organization': '조직 선택',
      'Authorize application': '앱 승인',
      'Activate device': '기기 활성화',
      'Approve sign-in request': '로그인 요청 승인',
      Profile: '프로필',
      Security: '보안',
      Connections: '연결',
      Sessions: '세션',
      'Trusted devices': '신뢰 기기',
      'Console overview': '콘솔 개요',
      Users: '사용자',
      Organizations: '조직',
      Settings: '설정',
      'Organization overview': '조직 개요',
      Members: '멤버',
      Roles: '역할',
      'Auth policy': '인증 정책',
      'Delivery channels': '전달 채널',
      'Social providers': '소셜 제공자',
      'Inbound enterprise SSO': '인바운드 엔터프라이즈 SSO',
      'Outbound enterprise SSO': '아웃바운드 엔터프라이즈 SSO',
      'Directory sync': '디렉터리 동기화',
      'SCIM targets': 'SCIM 대상',
      Domains: '도메인',
      Branding: '브랜딩',
      'OAuth applications': 'OAuth 앱',
      Webhooks: 'Webhook',
      'API keys': 'API 키',
      'Audit events': '감사 이벤트',
      'Platform overview': '플랫폼 개요',
      'Platform organizations': '플랫폼 조직',
      'Platform users': '플랫폼 사용자',
      'Event stream': '이벤트 스트림',
      'Feature flags': '기능 플래그',
      'Billing overview': '청구 개요',
      'Platform settings': '플랫폼 설정',
      'Getting started': '시작하기',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC 및 OAuth',
      'Enterprise SSO': '엔터프라이즈 SSO',
      'Social login': '소셜 로그인',
      'Management API': 'Management API',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDK',
      'Self-hosting': '셀프 호스팅',
    },
    descriptions: {
      home: 'XID는 Cloudflare에서 OIDC, OAuth, 조직 RBAC, 엔터프라이즈 SSO, SCIM, 패스키, 네트워크리스 JWT 검증을 제공하는 엣지 네이티브 ID 플랫폼입니다.',
      docs: 'XID의 OIDC, Hosted Auth, 엔터프라이즈 SSO, SCIM, SAML, Management API, Webhook, 브랜딩, SDK 연동 기술 문서입니다.',
    },
  },
}

const EU = {
  fr: {
    suffix: { docs: 'Docs XID', console: 'Console | XID', account: 'Compte | XID', plain: '| XID' },
    words: {
      'XID | Edge identity platform': 'XID | Plateforme d’identité edge',
      'Developer docs': 'Documentation développeur',
      'Page not found': 'Page introuvable',
      'Sign in': 'Connexion',
      'Sign up': 'Inscription',
      'Reset password': 'Réinitialiser le mot de passe',
      'Two-factor authentication': 'Authentification à deux facteurs',
      'Verify email': 'Vérifier l’e-mail',
      'Accept invitation': 'Accepter l’invitation',
      'Create organization': 'Créer une organisation',
      'Select organization': 'Choisir une organisation',
      'Authorize application': 'Autoriser l’application',
      'Activate device': 'Activer l’appareil',
      'Approve sign-in request': 'Approuver la demande de connexion',
      Profile: 'Profil',
      Security: 'Sécurité',
      Connections: 'Connexions',
      Sessions: 'Séances',
      'Trusted devices': 'Appareils de confiance',
      'Console overview': 'Vue d’ensemble de la console',
      Users: 'Utilisateurs',
      Organizations: 'Organisations',
      Settings: 'Paramètres',
      'Organization overview': 'Vue d’ensemble de l’organisation',
      Members: 'Membres',
      Roles: 'Rôles',
      'Auth policy': 'Politique d’authentification',
      'Delivery channels': 'Canaux de livraison',
      'Social providers': 'Fournisseurs sociaux',
      'Inbound enterprise SSO': 'SSO entreprise entrant',
      'Outbound enterprise SSO': 'SSO entreprise sortant',
      'Directory sync': 'Synchronisation d’annuaire',
      'SCIM targets': 'Cibles SCIM',
      Domains: 'Domaines',
      Branding: 'Image de marque',
      'OAuth applications': 'Applications OAuth',
      Webhooks: 'Hooks Web',
      'API keys': 'Clés API',
      'Audit events': 'Événements d’audit',
      'Platform overview': 'Vue d’ensemble de la plateforme',
      'Platform organizations': 'Organisations de la plateforme',
      'Platform users': 'Utilisateurs de la plateforme',
      'Event stream': 'Flux d’événements',
      'Feature flags': 'Indicateurs de fonctionnalité',
      'Billing overview': 'Vue d’ensemble de la facturation',
      'Platform settings': 'Paramètres de la plateforme',
      'Getting started': 'Premiers pas',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC et OAuth',
      'Enterprise SSO': 'SSO entreprise',
      'Social login': 'Connexion sociale',
      'Management API': 'API de gestion',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDK',
      'Self-hosting': 'Auto-hébergement',
    },
    descriptions: {
      home: 'XID est une plateforme d’identité edge native pour OIDC, OAuth, RBAC organisationnel, SSO entreprise, SCIM, passkeys et vérification JWT sans réseau sur Cloudflare.',
      docs: 'Documentation technique pour OIDC, Hosted Auth, SSO entreprise, SCIM, SAML, API de gestion, webhooks, image de marque et intégration SDK sur XID.',
    },
  },
  de: {
    suffix: { docs: 'XID-Docs', console: 'Konsole | XID', account: 'Konto | XID', plain: '| XID' },
    words: {
      'XID | Edge identity platform': 'XID | Edge-Identitätsplattform',
      'Developer docs': 'Entwicklerdokumentation',
      'Page not found': 'Seite nicht gefunden',
      'Sign in': 'Anmelden',
      'Sign up': 'Registrieren',
      'Reset password': 'Passwort zurücksetzen',
      'Two-factor authentication': 'Zwei-Faktor-Authentifizierung',
      'Verify email': 'E-Mail bestätigen',
      'Accept invitation': 'Einladung annehmen',
      'Create organization': 'Organisation erstellen',
      'Select organization': 'Organisation auswählen',
      'Authorize application': 'Anwendung autorisieren',
      'Activate device': 'Gerät aktivieren',
      'Approve sign-in request': 'Anmeldeanfrage genehmigen',
      Profile: 'Profil',
      Security: 'Sicherheit',
      Connections: 'Verbindungen',
      Sessions: 'Sitzungen',
      'Trusted devices': 'Vertrauenswürdige Geräte',
      'Console overview': 'Konsolenübersicht',
      Users: 'Benutzer',
      Organizations: 'Organisationen',
      Settings: 'Einstellungen',
      'Organization overview': 'Organisationsübersicht',
      Members: 'Mitglieder',
      Roles: 'Rollen',
      'Auth policy': 'Authentifizierungsrichtlinie',
      'Delivery channels': 'Zustellkanäle',
      'Social providers': 'Soziale Anbieter',
      'Inbound enterprise SSO': 'Eingehendes Enterprise-SSO',
      'Outbound enterprise SSO': 'Ausgehendes Enterprise-SSO',
      'Directory sync': 'Verzeichnissynchronisierung',
      'SCIM targets': 'SCIM-Ziele',
      Domains: 'Domains',
      Branding: 'Branding',
      'OAuth applications': 'OAuth-Anwendungen',
      Webhooks: 'Webhooks',
      'API keys': 'API-Schlüssel',
      'Audit events': 'Audit-Ereignisse',
      'Platform overview': 'Plattformübersicht',
      'Platform organizations': 'Plattformorganisationen',
      'Platform users': 'Plattformbenutzer',
      'Event stream': 'Ereignisstrom',
      'Feature flags': 'Feature-Flags',
      'Billing overview': 'Abrechnungsübersicht',
      'Platform settings': 'Plattformeinstellungen',
      'Getting started': 'Erste Schritte',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC und OAuth',
      'Enterprise SSO': 'Enterprise-SSO',
      'Social login': 'Social Login',
      'Management API': 'Management-API',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDKs',
      'Self-hosting': 'Self-Hosting',
    },
    descriptions: {
      home: 'XID ist eine edge-native Identitätsplattform für OIDC, OAuth, Organisations-RBAC, Enterprise-SSO, SCIM, Passkeys und netzwerklose JWT-Verifizierung auf Cloudflare.',
      docs: 'Technische Dokumentation für OIDC, Hosted Auth, Enterprise-SSO, SCIM, SAML, Management-API, Webhooks, Branding und SDK-Integration auf XID.',
    },
  },
  es: {
    suffix: { docs: 'Docs XID', console: 'Consola | XID', account: 'Cuenta | XID', plain: '| XID' },
    words: {
      'XID | Edge identity platform': 'XID | Plataforma de identidad edge',
      'Developer docs': 'Documentación para desarrolladores',
      'Page not found': 'Página no encontrada',
      'Sign in': 'Iniciar sesión',
      'Sign up': 'Registrarse',
      'Reset password': 'Restablecer contraseña',
      'Two-factor authentication': 'Autenticación de dos factores',
      'Verify email': 'Verificar correo',
      'Accept invitation': 'Aceptar invitación',
      'Create organization': 'Crear organización',
      'Select organization': 'Seleccionar organización',
      'Authorize application': 'Autorizar aplicación',
      'Activate device': 'Activar dispositivo',
      'Approve sign-in request': 'Aprobar solicitud de inicio de sesión',
      Profile: 'Perfil',
      Security: 'Seguridad',
      Connections: 'Conexiones',
      Sessions: 'Sesiones',
      'Trusted devices': 'Dispositivos de confianza',
      'Console overview': 'Resumen de la consola',
      Users: 'Usuarios',
      Organizations: 'Organizaciones',
      Settings: 'Configuración',
      'Organization overview': 'Resumen de la organización',
      Members: 'Miembros',
      Roles: 'Roles',
      'Auth policy': 'Política de autenticación',
      'Delivery channels': 'Canales de entrega',
      'Social providers': 'Proveedores sociales',
      'Inbound enterprise SSO': 'SSO empresarial entrante',
      'Outbound enterprise SSO': 'SSO empresarial saliente',
      'Directory sync': 'Sincronización de directorio',
      'SCIM targets': 'Destinos SCIM',
      Domains: 'Dominios',
      Branding: 'Marca',
      'OAuth applications': 'Aplicaciones OAuth',
      Webhooks: 'Webhooks',
      'API keys': 'Claves API',
      'Audit events': 'Eventos de auditoría',
      'Platform overview': 'Resumen de la plataforma',
      'Platform organizations': 'Organizaciones de la plataforma',
      'Platform users': 'Usuarios de la plataforma',
      'Event stream': 'Flujo de eventos',
      'Feature flags': 'Indicadores de funciones',
      'Billing overview': 'Resumen de facturación',
      'Platform settings': 'Configuración de la plataforma',
      'Getting started': 'Primeros pasos',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC y OAuth',
      'Enterprise SSO': 'SSO empresarial',
      'Social login': 'Inicio de sesión social',
      'Management API': 'API de administración',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDK',
      'Self-hosting': 'Autoalojamiento',
    },
    descriptions: {
      home: 'XID es una plataforma de identidad edge nativa para OIDC, OAuth, RBAC organizacional, SSO empresarial, SCIM, passkeys y verificación JWT sin red en Cloudflare.',
      docs: 'Documentación técnica para OIDC, Hosted Auth, SSO empresarial, SCIM, SAML, API de administración, webhooks, marca e integración de SDK en XID.',
    },
  },
  'pt-BR': {
    suffix: { docs: 'Docs XID', console: 'Console | XID', account: 'Conta | XID', plain: '| XID' },
    words: {
      'XID | Edge identity platform': 'XID | Plataforma de identidade edge',
      'Developer docs': 'Documentação para desenvolvedores',
      'Page not found': 'Página não encontrada',
      'Sign in': 'Entrar',
      'Sign up': 'Cadastrar-se',
      'Reset password': 'Redefinir senha',
      'Two-factor authentication': 'Autenticação de dois fatores',
      'Verify email': 'Verificar e-mail',
      'Accept invitation': 'Aceitar convite',
      'Create organization': 'Criar organização',
      'Select organization': 'Selecionar organização',
      'Authorize application': 'Autorizar aplicativo',
      'Activate device': 'Ativar dispositivo',
      'Approve sign-in request': 'Aprovar solicitação de login',
      Profile: 'Perfil',
      Security: 'Segurança',
      Connections: 'Conexões',
      Sessions: 'Sessões',
      'Trusted devices': 'Dispositivos confiáveis',
      'Console overview': 'Visão geral do console',
      Users: 'Usuários',
      Organizations: 'Organizações',
      Settings: 'Configurações',
      'Organization overview': 'Visão geral da organização',
      Members: 'Membros',
      Roles: 'Funções',
      'Auth policy': 'Política de autenticação',
      'Delivery channels': 'Canais de entrega',
      'Social providers': 'Provedores sociais',
      'Inbound enterprise SSO': 'SSO empresarial de entrada',
      'Outbound enterprise SSO': 'SSO empresarial de saída',
      'Directory sync': 'Sincronização de diretório',
      'SCIM targets': 'Destinos SCIM',
      Domains: 'Domínios',
      Branding: 'Marca',
      'OAuth applications': 'Aplicativos OAuth',
      Webhooks: 'Webhooks HTTP',
      'API keys': 'Chaves de API',
      'Audit events': 'Eventos de auditoria',
      'Platform overview': 'Visão geral da plataforma',
      'Platform organizations': 'Organizações da plataforma',
      'Platform users': 'Usuários da plataforma',
      'Event stream': 'Fluxo de eventos',
      'Feature flags': 'Sinalizadores de recurso',
      'Billing overview': 'Visão geral de cobrança',
      'Platform settings': 'Configurações da plataforma',
      'Getting started': 'Primeiros passos',
      'Hosted Auth': 'Hosted Auth',
      'OIDC and OAuth': 'OIDC e OAuth',
      'Enterprise SSO': 'SSO empresarial',
      'Social login': 'Login social',
      'Management API': 'API de gerenciamento',
      SCIM: 'SCIM',
      SAML: 'SAML',
      SDKs: 'SDKs',
      'Self-hosting': 'Auto-hospedagem',
    },
    descriptions: {
      home: 'XID é uma plataforma de identidade edge nativa para OIDC, OAuth, RBAC organizacional, SSO empresarial, SCIM, passkeys e verificação JWT sem rede no Cloudflare.',
      docs: 'Documentação técnica para OIDC, Hosted Auth, SSO empresarial, SCIM, SAML, API de gerenciamento, webhooks, marca e integração de SDK no XID.',
    },
  },
}

const DOC_DESCRIPTION_TRANSLATIONS = {
  'Connect an application to XID with OIDC discovery and Hosted Auth.': {
    'zh-Hans': '通过 OIDC Discovery 与 Hosted Auth 将应用接入 XID。',
    ja: 'OIDC Discovery と Hosted Auth でアプリを XID に接続します。',
    ko: 'OIDC Discovery와 Hosted Auth로 애플리케이션을 XID에 연결합니다.',
    fr: 'Connectez une application à XID avec la découverte OIDC et Hosted Auth.',
    de: 'Verbinden Sie eine Anwendung über OIDC Discovery und Hosted Auth mit XID.',
    es: 'Conecta una aplicación a XID con OIDC Discovery y Hosted Auth.',
    'pt-BR': 'Conecte um aplicativo ao XID com OIDC Discovery e Hosted Auth.',
  },
  'Configure the unified sign-in and user creation flow.': {
    'zh-Hans': '配置统一的登录与用户创建流程。',
    ja: '統合サインインとユーザー作成フローを設定します。',
    ko: '통합 로그인 및 사용자 생성 흐름을 구성합니다.',
    fr: 'Configurez le flux unifié de connexion et de création d’utilisateur.',
    de: 'Konfigurieren Sie den einheitlichen Anmelde- und Benutzererstellungsablauf.',
    es: 'Configura el flujo unificado de inicio de sesión y creación de usuarios.',
    'pt-BR': 'Configure o fluxo unificado de login e criação de usuários.',
  },
  'Discovery, authorization, token, logout, and OAuth extension endpoints.': {
    'zh-Hans': 'Discovery、授权、令牌、登出与 OAuth 扩展端点。',
    ja: 'Discovery、認可、トークン、ログアウト、OAuth 拡張エンドポイント。',
    ko: 'Discovery, 인가, 토큰, 로그아웃 및 OAuth 확장 엔드포인트.',
    fr: 'Points de terminaison de découverte, autorisation, jeton, déconnexion et extensions OAuth.',
    de: 'Discovery-, Autorisierungs-, Token-, Logout- und OAuth-Erweiterungsendpunkte.',
    es: 'Endpoints de discovery, autorización, token, cierre de sesión y extensiones OAuth.',
    'pt-BR': 'Endpoints de discovery, autorização, token, logout e extensões OAuth.',
  },
  'Configure upstream enterprise IdPs and track downstream SaaS SSO boundaries.': {
    'zh-Hans': '配置上游企业 IdP,并明确下游 SaaS SSO 边界。',
    ja: '上流のエンタープライズ IdP を設定し、下流 SaaS SSO の境界を明確にします。',
    ko: '업스트림 엔터프라이즈 IdP를 구성하고 다운스트림 SaaS SSO 경계를 추적합니다.',
    fr: 'Configurez les IdP entreprise en amont et les limites SSO SaaS en aval.',
    de: 'Konfigurieren Sie vorgelagerte Enterprise-IdPs und SaaS-SSO-Grenzen nachgelagert.',
    es: 'Configura IdP empresariales ascendentes y los límites de SSO SaaS descendentes.',
    'pt-BR': 'Configure IdPs empresariais upstream e limites de SSO SaaS downstream.',
  },
  'Configure social OAuth providers with clear production support boundaries.': {
    'zh-Hans': '配置社交 OAuth 提供商,并明确生产支持边界。',
    ja: 'ソーシャル OAuth プロバイダを設定し、本番サポート境界を明確にします。',
    ko: '소셜 OAuth 제공자를 구성하고 프로덕션 지원 경계를 명확히 합니다.',
    fr: 'Configurez les fournisseurs OAuth sociaux avec des limites de support en production.',
    de: 'Konfigurieren Sie soziale OAuth-Provider mit klaren Produktionsgrenzen.',
    es: 'Configura proveedores OAuth sociales con límites claros de soporte en producción.',
    'pt-BR': 'Configure provedores OAuth sociais com limites claros de suporte em produção.',
  },
  'Use scoped API keys to manage organization resources from your backend.': {
    'zh-Hans': '使用带 scope 的 API 密钥在后端管理组织资源。',
    ja: 'スコープ付き API キーでバックエンドから組織リソースを管理します。',
    ko: '범위가 지정된 API 키로 백엔드에서 조직 리소스를 관리합니다.',
    fr: 'Utilisez des clés API à portée limitée pour gérer les ressources d’organisation.',
    de: 'Verwalten Sie Organisationsressourcen mit scoped API-Schlüsseln im Backend.',
    es: 'Usa claves API con alcance para gestionar recursos de la organización desde tu backend.',
    'pt-BR': 'Use chaves de API com escopo para gerenciar recursos da organização no backend.',
  },
  'Subscribe to XID events and receive signed HTTP payloads for user and org changes.': {
    'zh-Hans': '订阅 XID 事件,接收用户与组织变更的签名 HTTP 负载。',
    ja: 'XID イベントを購読し、ユーザーと組織の変更を署名付き HTTP ペイロードで受信します。',
    ko: 'XID 이벤트를 구독하고 사용자 및 조직 변경에 대한 서명된 HTTP 페이로드를 받습니다.',
    fr: 'Abonnez-vous aux événements XID et recevez des charges HTTP signées.',
    de: 'Abonnieren Sie XID-Ereignisse und erhalten Sie signierte HTTP-Nutzlasten.',
    es: 'Suscríbete a eventos de XID y recibe cargas HTTP firmadas de cambios de usuario y organización.',
    'pt-BR':
      'Assine eventos do XID e receba payloads HTTP assinados de mudanças de usuário e organização.',
  },
  'Customize Hosted Auth with colors, fonts, radius, logos, and custom CSS.': {
    'zh-Hans': '通过颜色、字体、圆角、Logo 与自定义 CSS 定制 Hosted Auth。',
    ja: '色、フォント、角丸、ロゴ、カスタム CSS で Hosted Auth をカスタマイズします。',
    ko: '색상, 글꼴, 반경, 로고 및 사용자 정의 CSS로 Hosted Auth를 맞춤 설정합니다.',
    fr: 'Personnalisez Hosted Auth avec couleurs, polices, rayons, logos et CSS personnalisé.',
    de: 'Passen Sie Hosted Auth mit Farben, Schriften, Radien, Logos und eigenem CSS an.',
    es: 'Personaliza Hosted Auth con colores, fuentes, radios, logos y CSS personalizado.',
    'pt-BR': 'Personalize o Hosted Auth com cores, fontes, raios, logos e CSS personalizado.',
  },
  'SCIM 2.0 endpoint contract for provisioning users and groups into XID.': {
    'zh-Hans': '用于向 XID 预配用户与组的 SCIM 2.0 端点契约。',
    ja: 'XID にユーザーとグループをプロビジョニングする SCIM 2.0 エンドポイント契約。',
    ko: 'XID에 사용자와 그룹을 프로비저닝하는 SCIM 2.0 엔드포인트 계약.',
    fr: 'Contrat d’endpoint SCIM 2.0 pour provisionner utilisateurs et groupes dans XID.',
    de: 'SCIM-2.0-Endpunktvertrag zur Bereitstellung von Benutzern und Gruppen in XID.',
    es: 'Contrato de endpoint SCIM 2.0 para aprovisionar usuarios y grupos en XID.',
    'pt-BR': 'Contrato de endpoint SCIM 2.0 para provisionar usuários e grupos no XID.',
  },
  'Connect enterprise identity providers using SAML 2.0.': {
    'zh-Hans': '使用 SAML 2.0 连接企业身份提供商。',
    ja: 'SAML 2.0 でエンタープライズ ID プロバイダを接続します。',
    ko: 'SAML 2.0으로 엔터프라이즈 ID 제공자를 연결합니다.',
    fr: 'Connectez des fournisseurs d’identité entreprise avec SAML 2.0.',
    de: 'Verbinden Sie Enterprise-Identitätsanbieter mit SAML 2.0.',
    es: 'Conecta proveedores de identidad empresarial con SAML 2.0.',
    'pt-BR': 'Conecte provedores de identidade empresarial com SAML 2.0.',
  },
  'TypeScript packages and locally verified native SDKs for server, web, mobile, and desktop.': {
    'zh-Hans': '面向服务端、Web、移动端与桌面的 TypeScript 包及本地验证原生 SDK。',
    ja: 'サーバー、Web、モバイル、デスクトップ向けの TypeScript パッケージとローカル検証済みネイティブ SDK。',
    ko: '서버, 웹, 모바일, 데스크톱용 TypeScript 패키지와 로컬 검증 네이티브 SDK.',
    fr: 'Packages TypeScript et SDK natifs vérifiés localement pour serveur, web, mobile et desktop.',
    de: 'TypeScript-Pakete und lokal verifizierte native SDKs für Server, Web, Mobile und Desktop.',
    es: 'Paquetes TypeScript y SDK nativos verificados localmente para servidor, web, móvil y escritorio.',
    'pt-BR':
      'Pacotes TypeScript e SDKs nativos verificados localmente para servidor, web, mobile e desktop.',
  },
  'Browser SDK for session state, tokens, and XID API calls in web apps.': {
    'zh-Hans': '用于 Web 应用会话状态、令牌与 XID API 调用的浏览器 SDK。',
    ja: 'Web アプリのセッション状態、トークン、XID API 呼び出し向けブラウザ SDK。',
    ko: '웹 앱의 세션 상태, 토큰, XID API 호출을 위한 브라우저 SDK.',
    fr: 'SDK navigateur pour l’état de session, les jetons et les appels API XID.',
    de: 'Browser-SDK für Sitzungsstatus, Tokens und XID-API-Aufrufe in Web-Apps.',
    es: 'SDK de navegador para estado de sesión, tokens y llamadas API de XID.',
    'pt-BR': 'SDK de navegador para estado de sessão, tokens e chamadas de API do XID.',
  },
  'Server SDK for networkless JWT verification on Cloudflare Workers and Node.': {
    'zh-Hans': '在 Cloudflare Workers 与 Node 上进行无网络 JWT 校验的服务端 SDK。',
    ja: 'Cloudflare Workers と Node でネットワークレス JWT 検証を行うサーバー SDK。',
    ko: 'Cloudflare Workers와 Node에서 네트워크리스 JWT 검증을 위한 서버 SDK.',
    fr: 'SDK serveur pour la vérification JWT sans réseau sur Cloudflare Workers et Node.',
    de: 'Server-SDK für netzwerklose JWT-Verifizierung auf Cloudflare Workers und Node.',
    es: 'SDK de servidor para verificación JWT sin red en Cloudflare Workers y Node.',
    'pt-BR': 'SDK de servidor para verificação JWT sem rede no Cloudflare Workers e Node.',
  },
  'React bindings for XID session state, hooks, and hosted UI components.': {
    'zh-Hans': 'XID 会话状态、Hooks 与托管 UI 组件的 React 绑定。',
    ja: 'XID セッション状態、フック、Hosted UI コンポーネント向け React バインディング。',
    ko: 'XID 세션 상태, 훅, Hosted UI 컴포넌트용 React 바인딩.',
    fr: 'Bindings React pour l’état de session XID, les hooks et les composants Hosted UI.',
    de: 'React-Bindings für XID-Sitzungsstatus, Hooks und Hosted-UI-Komponenten.',
    es: 'Bindings de React para estado de sesión XID, hooks y componentes de Hosted UI.',
    'pt-BR': 'Bindings React para estado de sessão XID, hooks e componentes de Hosted UI.',
  },
  'Next.js helpers for XID authentication in App Router and middleware.': {
    'zh-Hans': '适用于 App Router 与中间件的 XID 认证 Next.js 辅助工具。',
    ja: 'App Router とミドルウェア向け XID 認証 Next.js ヘルパー。',
    ko: 'App Router와 미들웨어용 XID 인증 Next.js 헬퍼.',
    fr: 'Helpers Next.js pour l’authentification XID dans App Router et le middleware.',
    de: 'Next.js-Helfer für XID-Authentifizierung in App Router und Middleware.',
    es: 'Helpers de Next.js para autenticación XID en App Router y middleware.',
    'pt-BR': 'Helpers Next.js para autenticação XID no App Router e middleware.',
  },
  'Run XID on your own Cloudflare account with Workers, D1, KV, R2, and Durable Objects.': {
    'zh-Hans': '在你自己的 Cloudflare 账户上运行 XID(Workers、D1、KV、R2、Durable Objects)。',
    ja: 'Workers、D1、KV、R2、Durable Objects で自分の Cloudflare アカウント上に XID を実行します。',
    ko: 'Workers, D1, KV, R2, Durable Objects로 자체 Cloudflare 계정에서 XID를 실행합니다.',
    fr: 'Exécutez XID sur votre compte Cloudflare avec Workers, D1, KV, R2 et Durable Objects.',
    de: 'Betreiben Sie XID auf Ihrem Cloudflare-Konto mit Workers, D1, KV, R2 und Durable Objects.',
    es: 'Ejecuta XID en tu cuenta de Cloudflare con Workers, D1, KV, R2 y Durable Objects.',
    'pt-BR': 'Execute o XID na sua conta Cloudflare com Workers, D1, KV, R2 e Durable Objects.',
  },
}

function readMsgid(block) {
  const lines = block.split('\n')
  const parts = []
  let inMsgid = false

  for (const line of lines) {
    if (line.startsWith('msgid ')) {
      inMsgid = true
      if (line === 'msgid ""') continue
      const match = line.match(/^msgid "((?:\\.|[^"\\])*)"$/)
      if (match) parts.push(JSON.parse(`"${match[1]}"`))
      continue
    }
    if (inMsgid && line.startsWith('"') && !line.startsWith('msgstr')) {
      parts.push(JSON.parse(line.trim()))
      continue
    }
    if (line.startsWith('msgstr')) break
  }

  return parts.length > 0 ? parts.join('') : null
}

function translateMsgid(msgid, locale) {
  const docDescription = DOC_DESCRIPTION_TRANSLATIONS[msgid]?.[locale]
  if (docDescription) return docDescription

  const pack = CJK[locale] ?? EU[locale]
  if (!pack) return null
  if (msgid.startsWith('XID is an edge-native')) return pack.descriptions.home
  if (msgid.startsWith('Technical documentation for OIDC')) return pack.descriptions.docs
  if (pack.words[msgid]) return pack.words[msgid]
  if (msgid.endsWith(' | XID Docs')) {
    const stem = msgid.slice(0, -' | XID Docs'.length)
    return `${pack.words[stem] ?? stem} | ${pack.suffix.docs}`
  }
  if (msgid.endsWith(' | Console | XID')) {
    const stem = msgid.slice(0, -' | Console | XID'.length)
    return `${pack.words[stem] ?? stem} | ${pack.suffix.console}`
  }
  if (msgid.endsWith(' | Account | XID')) {
    const stem = msgid.slice(0, -' | Account | XID'.length)
    return `${pack.words[stem] ?? stem} | ${pack.suffix.account}`
  }
  if (msgid.endsWith(' | XID')) {
    const stem = msgid.slice(0, -' | XID'.length)
    return `${pack.words[stem] ?? stem} | ${pack.suffix.plain}`
  }
  return null
}

function poEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function setMsgstr(block, translation) {
  const escaped = poEscape(translation)
  if (block.includes('msgid ""')) {
    return block.replace(/^msgstr ""$/m, `msgstr "${escaped}"`)
  }
  return block.replace(/^msgstr "((?:\\.|[^"\\])*)"$/m, `msgstr "${escaped}"`)
}

for (const locale of LOCALES) {
  const path = join(ROOT, 'packages/i18n/locales', locale, 'messages.po')
  const blocks = readFileSync(path, 'utf8').split(/\n\n+/)
  const missing = []
  const next = blocks.map((block) => {
    if (!block.includes('page-seo-messages')) return block
    const msgid = readMsgid(block)
    if (!msgid) return block
    const translation = translateMsgid(msgid, locale)
    if (!translation) {
      missing.push(msgid)
      return block
    }
    return setMsgstr(block, translation)
  })
  if (missing.length > 0) {
    process.stderr.write(`[${locale}] missing translations: ${missing.join(', ')}\n`)
    process.exit(1)
  }
  writeFileSync(path, `${next.join('\n\n')}\n`)
}

const HINT_TRANSLATIONS = {
  'zh-Hans': '受限模式会将出站 SSO 启动和 SCIM 同步限制为具有所选角色或显式用户 ID 的成员。',
  ja: '制限モードでは、選択したロールまたは明示的なユーザー ID を持つメンバーにのみ、アウトバウンド SSO 起動と SCIM 同期が許可されます。',
  ko: '제한 모드는 선택한 역할 또는 명시적 사용자 ID를 가진 멤버에게만 아웃바운드 SSO 시작 및 SCIM 동기화를 허용합니다.',
  fr: 'Le mode restreint limite le lancement SSO sortant et la synchronisation SCIM aux membres ayant les rôles sélectionnés ou des ID utilisateur explicites.',
  de: 'Der eingeschränkte Modus beschränkt ausgehendes SSO und die SCIM-Synchronisierung auf Mitglieder mit ausgewählten Rollen oder expliziten Benutzer-IDs.',
  es: 'El modo restringido limita el inicio de SSO saliente y la sincronización SCIM a miembros con roles seleccionados o ID de usuario explícitos.',
  'pt-BR':
    'O modo restrito limita o início de SSO de saída e a sincronização SCIM a membros com funções selecionadas ou IDs de usuário explícitos.',
}

const HINT_MSGID =
  'Restricted mode limits outbound SSO launch and SCIM sync to members with selected roles or explicit user IDs.'

for (const locale of LOCALES) {
  const path = join(ROOT, 'packages/i18n/locales', locale, 'messages.po')
  const blocks = readFileSync(path, 'utf8').split(/\n\n+/)
  const next = blocks.map((block) => {
    if (!block.includes('OrgOutboundSso.tsx')) return block
    const msgid = readMsgid(block)
    if (msgid !== HINT_MSGID) return block
    const translation = HINT_TRANSLATIONS[locale]
    if (!translation) return block
    return setMsgstr(block, translation)
  })
  writeFileSync(path, `${next.join('\n\n')}\n`)
}

process.stdout.write(`filled page-seo translations for ${LOCALES.join(', ')}\n`)

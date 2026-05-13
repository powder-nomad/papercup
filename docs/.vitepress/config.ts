import { defineConfig, type DefaultTheme } from "vitepress";

const enNav: DefaultTheme.NavItem[] = [
  { text: "Install", link: "/install/" },
  { text: "Architecture", link: "/architecture/" },
  { text: "Components", link: "/components/voice-pipeline" },
  { text: "Config", link: "/config" },
  { text: "Security", link: "/security" },
  { text: "Troubleshooting", link: "/troubleshooting" },
  { text: "GitHub", link: "https://github.com/powder-nomad/papercup" },
];

const enSidebar: DefaultTheme.SidebarMulti = {
  "/install/": [
    {
      text: "Install Papercup",
      items: [
        { text: "Overview", link: "/install/" },
        { text: "One-liner installer", link: "/install/one-liner" },
        { text: "Windows", link: "/install/windows" },
        { text: "Claude Code plugin", link: "/install/cc-plugin" },
        { text: "Standalone (manual)", link: "/install/standalone" },
        { text: "OpenClaw plugin", link: "/install/openclaw" },
      ],
    },
  ],
  "/architecture/": [
    {
      text: "Architecture",
      items: [
        { text: "Overview", link: "/architecture/" },
        { text: "Pipeline stages", link: "/architecture/pipeline" },
        { text: "Repo layout", link: "/architecture/repo-layout" },
      ],
    },
  ],
  "/components/": [
    {
      text: "Components",
      items: [
        { text: "Voice pipeline (VAD/STT/TTS)", link: "/components/voice-pipeline" },
        { text: "Speaker agent + backends", link: "/components/speaker-agent" },
        { text: "Slash commands", link: "/components/slash-commands" },
        { text: "Extension subagents", link: "/components/extensions" },
        { text: "Sessions", link: "/components/sessions" },
        { text: "Channel binding", link: "/components/channel-binding" },
        { text: "Process management", link: "/components/process-management" },
        { text: "Multi-bot orchestration", link: "/components/multi-bot" },
        { text: "Korean (and other languages)", link: "/components/korean" },
      ],
    },
  ],
};

const koNav: DefaultTheme.NavItem[] = [
  { text: "설치", link: "/ko/install/" },
  { text: "아키텍처", link: "/ko/architecture/" },
  { text: "구성요소", link: "/ko/components/voice-pipeline" },
  { text: "설정", link: "/ko/config" },
  { text: "보안", link: "/ko/security" },
  { text: "문제 해결", link: "/ko/troubleshooting" },
  { text: "GitHub", link: "https://github.com/powder-nomad/papercup" },
];

const koSidebar: DefaultTheme.SidebarMulti = {
  "/ko/install/": [
    {
      text: "Papercup 설치",
      items: [
        { text: "개요", link: "/ko/install/" },
        { text: "원라이너 설치", link: "/ko/install/one-liner" },
        { text: "Windows", link: "/ko/install/windows" },
        { text: "Claude Code 플러그인", link: "/ko/install/cc-plugin" },
        { text: "독립 실행 (수동)", link: "/ko/install/standalone" },
        { text: "OpenClaw 플러그인", link: "/ko/install/openclaw" },
      ],
    },
  ],
  "/ko/architecture/": [
    {
      text: "아키텍처",
      items: [
        { text: "개요", link: "/ko/architecture/" },
        { text: "파이프라인 단계", link: "/ko/architecture/pipeline" },
        { text: "저장소 구조", link: "/ko/architecture/repo-layout" },
      ],
    },
  ],
  "/ko/components/": [
    {
      text: "구성요소",
      items: [
        { text: "음성 파이프라인 (VAD/STT/TTS)", link: "/ko/components/voice-pipeline" },
        { text: "스피커 에이전트 + 백엔드", link: "/ko/components/speaker-agent" },
        { text: "슬래시 명령", link: "/ko/components/slash-commands" },
        { text: "확장 서브에이전트", link: "/ko/components/extensions" },
        { text: "세션", link: "/ko/components/sessions" },
        { text: "채널 바인딩", link: "/ko/components/channel-binding" },
        { text: "프로세스 관리", link: "/ko/components/process-management" },
        { text: "멀티봇 오케스트레이션", link: "/ko/components/multi-bot" },
        { text: "한국어 (및 기타 언어)", link: "/ko/components/korean" },
      ],
    },
  ],
};

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Papercup",
  description: "Voice interface to Claude Code via Discord. Local voice stack + speaker agent + extension subagents.",
  // GitHub Pages serves at /papercup/ when deployed under powder-nomad.github.io/papercup
  base: "/papercup/",
  cleanUrls: true,

  head: [
    ["meta", { name: "theme-color", content: "#5865f2" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/papercup/favicon.svg" }],
  ],

  themeConfig: {
    socialLinks: [{ icon: "github", link: "https://github.com/powder-nomad/papercup" }],
    search: { provider: "local" },
  },

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        footer: {
          message: "Released under the MIT License.",
          copyright: "© Paul Kim",
        },
      },
    },
    ko: {
      label: "한국어",
      lang: "ko",
      title: "Papercup",
      description: "Discord를 통한 Claude Code 음성 인터페이스. 로컬 음성 스택 + 스피커 에이전트 + 확장 서브에이전트.",
      themeConfig: {
        nav: koNav,
        sidebar: koSidebar,
        outline: { label: "이 페이지" },
        docFooter: { prev: "이전", next: "다음" },
        lastUpdatedText: "마지막 업데이트",
        darkModeSwitchLabel: "테마",
        sidebarMenuLabel: "메뉴",
        returnToTopLabel: "맨 위로",
        footer: {
          message: "MIT 라이선스로 배포됨",
          copyright: "© Paul Kim",
        },
      },
    },
  },
});

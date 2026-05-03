import DefaultTheme from "vitepress/theme";
import InstallerWizard from "../components/InstallerWizard.vue";
import HeroCall from "../components/HeroCall.vue";
import OneLiner from "../components/OneLiner.vue";
import type { App } from "vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: App }) {
    app.component("InstallerWizard", InstallerWizard);
    app.component("HeroCall", HeroCall);
    app.component("OneLiner", OneLiner);
  },
};

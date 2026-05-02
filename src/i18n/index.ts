import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import about from "./locales/en/about.json";
import app from "./locales/en/app.json";
import centre from "./locales/en/centre.json";
import clone from "./locales/en/clone.json";
import common from "./locales/en/common.json";
import diffPanel from "./locales/en/diffPanel.json";
import git from "./locales/en/git.json";
import identity from "./locales/en/identity.json";
import projectView from "./locales/en/projectView.json";
import resultLog from "./locales/en/resultLog.json";
import settings from "./locales/en/settings.json";
import sidebar from "./locales/en/sidebar.json";
import titlebar from "./locales/en/titlebar.json";
import update from "./locales/en/update.json";

export const namespaces = [
  "about",
  "app",
  "centre",
  "clone",
  "common",
  "diffPanel",
  "git",
  "identity",
  "projectView",
  "resultLog",
  "settings",
  "sidebar",
  "titlebar",
  "update",
] as const;

i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: ["en"],
    ns: namespaces,
    defaultNS: "common",
    resources: {
      en: {
        about,
        app,
        centre,
        clone,
        common,
        diffPanel,
        git,
        identity,
        projectView,
        resultLog,
        settings,
        sidebar,
        titlebar,
        update,
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;

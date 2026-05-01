import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import projectView from "./locales/en/projectView.json";

i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: ["en"],
    ns: ["projectView"],
    defaultNS: "projectView",
    resources: {
      en: {
        projectView,
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;

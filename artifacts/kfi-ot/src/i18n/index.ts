import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import es from "./es.json";
import esStatus from "./es.status.json";

export type SupportedLocale = "en" | "es";
export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "es"];

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;

export function setLanguage(lng: SupportedLocale) {
  void i18n.changeLanguage(lng);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", lng);
  }
}

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

export function getCoverageReport() {
  const enKeys = new Set(flatten(en as Record<string, unknown>));
  const esKeys = new Set(flatten(es as Record<string, unknown>));
  const machineEs = new Set(esStatus.machineTranslated as string[]);
  const allKeys = new Set([...enKeys, ...esKeys]);
  const missing: { locale: SupportedLocale; keys: string[]; machineTranslated: string[] }[] = [
    {
      locale: "en",
      keys: [...allKeys].filter((k) => !enKeys.has(k)).sort(),
      machineTranslated: [],
    },
    {
      locale: "es",
      keys: [...allKeys].filter((k) => !esKeys.has(k)).sort(),
      machineTranslated: [...machineEs].filter((k) => esKeys.has(k)).sort(),
    },
  ];
  return {
    locales: SUPPORTED_LOCALES,
    totalKeys: allKeys.size,
    missing,
  };
}

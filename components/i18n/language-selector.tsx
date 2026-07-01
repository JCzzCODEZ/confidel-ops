"use client";

import type { Lang } from "../../lib/i18n/employee";

// Small English / Español toggle. Labels intentionally stay in their own language.
export function LanguageSelector({
  lang,
  onChange,
  ariaLabel = "Language",
}: {
  lang: Lang;
  onChange: (lang: Lang) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="button-row" role="group" aria-label={ariaLabel} data-testid="lang-selector">
      <button
        type="button"
        className={`btn small ${lang === "en" ? "gold" : "secondary"}`}
        aria-pressed={lang === "en"}
        data-testid="lang-en"
        onClick={() => onChange("en")}
      >
        English
      </button>
      <button
        type="button"
        className={`btn small ${lang === "es" ? "gold" : "secondary"}`}
        aria-pressed={lang === "es"}
        data-testid="lang-es"
        onClick={() => onChange("es")}
      >
        Español
      </button>
    </div>
  );
}

'use strict';

const I18n = (() => {
  const translations = {};
  let currentLang = localStorage.getItem('naval-command-lang') || 'en';

  async function loadLanguage(lang) {
    if (translations[lang]) return;
    const basePath = location.pathname.replace(/\/+$/, '');
    const res = await fetch(`${basePath}/lang/${lang}.json`);
    translations[lang] = await res.json();
  }

  function t(key, params) {
    const dict = translations[currentLang] || translations['en'] || {};
    let str = dict[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return str;
  }

  function getLang() {
    return currentLang;
  }

  async function setLang(lang) {
    await loadLanguage(lang);
    currentLang = lang;
    localStorage.setItem('naval-command-lang', lang);
    translateDOM();
    document.documentElement.lang = lang;
    // Dispatch event so game.js can update dynamic text
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  function translateDOM() {
    // Translate elements with data-i18n attribute (textContent)
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    // Translate elements with data-i18n-html attribute (innerHTML)
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    // Translate aria-label
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
  }

  async function init() {
    await loadLanguage('en');
    if (currentLang !== 'en') {
      await loadLanguage(currentLang);
    }
    translateDOM();
    document.documentElement.lang = currentLang;
  }

  return { t, getLang, setLang, init, translateDOM };
})();

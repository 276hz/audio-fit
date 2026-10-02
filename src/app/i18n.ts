export type Dict = Record<string, string>;
let dict: Dict = {}, fallback: Dict = {}, lang = 'en';
export async function loadLang(l: string): Promise<void> {
  lang = l;
  const get = async (x: string) => (await fetch(`./i18n/${x}.json`)).json() as Promise<Dict>;
  fallback = await get('en'); dict = l === 'en' ? fallback : await get(l);
  document.documentElement.lang = l;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria!)); });
}
export const getLang = () => lang;
export function t(key: string, params: Record<string, string | number> = {}): string {
  const s = dict[key] ?? fallback[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

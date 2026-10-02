export const fmtMB = (bytes: number, lang: string) => `${(bytes / 1e6).toLocaleString(lang, { maximumFractionDigits: 1, minimumFractionDigits: bytes < 1e7 ? 1 : 0 })} MB`;
export const fmtDur = (sec: number) => { const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(r).padStart(2, '0')}`; };
export const fmtHz = (hz: number, lang: string) => `${(hz / 1000).toLocaleString(lang, { maximumFractionDigits: 1 })} kHz`;

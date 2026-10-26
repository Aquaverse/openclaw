// Scoped under .nexus-page so nothing leaks into the host. Colors follow the host theme through currentColor; only the
// status accents are fixed (mid-tone, readable on light and dark).
export const NEXUS_CSS = `
.nexus-page [hidden]{display:none !important}
.nexus-page{padding:16px 20px;font:14px/1.5 system-ui,sans-serif;color:inherit;max-width:1040px}
.nexus-page nav{display:flex;gap:16px;align-items:center;border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent);padding-bottom:8px;margin-bottom:8px}
.nexus-page nav a{color:inherit;opacity:.65;text-decoration:none}
.nexus-page nav a.on{opacity:1;font-weight:600}
.nexus-page nav .spacer{flex:1}
.nexus-page nav button{font:inherit;color:inherit;background:none;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:2px 10px;cursor:pointer;opacity:.8}
.nexus-page h1{font-size:20px;margin:12px 0}
.nexus-page h2{font-size:15px;margin:20px 0 6px;opacity:.7}
.nexus-page table{border-collapse:collapse;width:100%}
.nexus-page th,.nexus-page td{text-align:left;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);padding:6px 8px;vertical-align:top}
.nexus-page th{opacity:.65;font-weight:500}
.nexus-page code,.nexus-page pre{font:12px/1.4 ui-monospace,monospace}
.nexus-page pre{margin:0;white-space:pre-wrap;word-break:break-word}
.nexus-page a{color:#4f7cff}
.nexus-page .muted{opacity:.65}
.nexus-page .pill{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:10px;padding:0 8px}
.nexus-page .pending{color:#d98a1f}.nexus-page .bad{color:#e5534b}.nexus-page .ok{color:#2fa56b}
.nexus-page .hint{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;padding:8px 12px;margin:8px 0}
.nexus-page .error{color:#e5534b;margin:12px 0}
.nexus-page .nx-notice{margin:8px 0;padding:6px 12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px}
.nexus-page .nx-notice.ok{color:#2fa56b}
.nexus-page .nx-btn{font:inherit;color:inherit;background:none;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:1px 10px;cursor:pointer}
.nexus-page .nx-btn:disabled{opacity:.45;cursor:not-allowed}
.nexus-page .nx-primary{background:#4f7cff;border-color:#4f7cff;color:#fff}
.nexus-page .nx-danger{border-color:#e5534b;color:#e5534b}
.nexus-page .hint .nx-btn{margin-left:8px}
.nexus-page .nx-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.nexus-page .nx-dialog{background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:10px;max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:16px 20px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.nexus-page .nx-title{font-size:16px;margin:0 0 8px;opacity:1}
.nexus-page .nx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;position:sticky;top:-16px;z-index:2;background:Canvas;margin:-16px -20px 0;padding:16px 20px 8px}
.nexus-page .nx-head .nx-title{margin:0;min-width:0;word-break:break-word}
.nexus-page .nx-x{flex:0 0 auto;font:inherit;font-size:22px;line-height:1;color:inherit;background:none;border:none;border-radius:6px;padding:0 6px;cursor:pointer;opacity:.7}
.nexus-page .nx-x:hover{opacity:1}
.nexus-page .nx-x:disabled{opacity:.35;cursor:not-allowed}
.nexus-page .nx-row{display:flex;gap:12px;align-items:flex-start;margin:6px 0}
.nexus-page .nx-label{flex:0 0 88px;opacity:.65}
.nexus-page .nx-value{flex:1;min-width:0;word-break:break-word}
.nexus-page .nx-row input,.nexus-page .nx-row textarea,.nexus-page .nx-row select{flex:1;min-width:0;font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:4px 8px}
.nexus-page .nx-row textarea{font:12px/1.4 ui-monospace,monospace}
.nexus-page .nx-original{max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,monospace;margin:8px 0 0;padding:8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px}
.nexus-page .nx-check{align-items:center}
.nexus-page .nx-check input{flex:0 0 auto}
.nexus-page .nx-filters{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;padding:8px 12px;margin:8px 0}
.nexus-page .nx-filters label{display:flex;gap:4px;align-items:center;opacity:.85}
.nexus-page .nx-filters input,.nexus-page .nx-filters select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:2px 8px}
.nexus-page .nx-filters .f-keyword input{width:22em;max-width:100%}
.nexus-page .nx-filters .f-presets{flex-basis:100%}
.nexus-page .nx-filerow{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:8px 0}
.nexus-page .nx-filebar-slot{display:contents}
.nexus-page .nx-filebar{margin:0;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.nexus-page .nx-filebar label{display:flex;gap:4px;align-items:center;opacity:.85}
.nexus-page .nx-filebar input,.nexus-page .nx-filebar select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:2px 8px}
.nexus-page .nx-filebar .f-name input{width:18em;max-width:100%}
.nexus-page .nx-filters .f-from input,.nexus-page .nx-filters .f-to input{width:11em}
.nexus-page .nx-link{font:inherit;color:#4f7cff;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}
.nexus-page .pager{margin:8px 0;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.nexus-page .pager .cur{font-weight:600}
.nexus-page .nx-tabs{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0}
.nexus-page .nx-tabs a{color:inherit;opacity:.65;text-decoration:none}
.nexus-page .nx-tabs a.on{opacity:1;font-weight:600}
.nexus-page .nx-footer{display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:-16px;z-index:2;background:Canvas;margin:12px -20px -16px;padding:8px 20px 16px}
`;

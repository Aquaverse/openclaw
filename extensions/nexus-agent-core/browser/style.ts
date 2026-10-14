// Scoped under .nexus-page so nothing leaks into the host. Colors follow the host theme through currentColor; only the
// status accents are fixed (mid-tone, readable on light and dark).
export const NEXUS_CSS = `
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
`;

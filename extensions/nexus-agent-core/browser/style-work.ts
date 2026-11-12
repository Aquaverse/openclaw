// The Work page, laid out like the prototype (docs/prd/design/nexus-work.html): a 380px list pane (title, hello line, search
// box, pills, dot rows) and the detail pane (top bar, title, state line, progress ring, ask card, criteria, activity).
// Narrow screens show the list or the detail, not both. The progress ring is drawn from a plain class (`nx-p0` .. `nx-p100`
// in steps of 5) because the page markup carries no inline style.
const RING_CLASSES = Array.from({ length: 21 }, (_, i) => `.nx-p${i * 5}{--p:${i * 5}}`).join("");

export const NEXUS_WORK_CSS = `
.nx-t-amber{--c:var(--nx-amber);--cs:var(--nx-amber-soft)}
.nx-t-rose{--c:var(--nx-rose);--cs:var(--nx-rose-soft)}
.nx-t-blue{--c:var(--nx-blue);--cs:var(--nx-blue-soft)}
.nx-t-green{--c:var(--nx-green);--cs:var(--nx-green-soft)}
.nx-t-gray,.nx-t-accent{--c:var(--nx-gray);--cs:var(--nx-gray-soft)}
${RING_CLASSES}
.nx-works{display:grid;grid-template-columns:380px minmax(0,1fr);align-items:start;background:linear-gradient(to right,var(--nx-panel) 0 379px,var(--nx-line) 379px 380px,var(--nx-bg) 380px);color:var(--nx-text);min-height:100vh}
.nx-wlist{display:flex;flex-direction:column;background:var(--nx-panel);min-width:0;position:sticky;top:0;height:100vh;box-sizing:border-box}
.nx-lh{padding:26px 24px 14px}
.nexus-page .nx-wlist h1{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0}
.nx-hello{color:var(--nx-sub);font-size:13px;margin:4px 0 0}
.nexus-page .nx-wsearch{margin-top:16px;display:flex;align-items:center;gap:8px;background:var(--nx-soft);border-radius:10px;padding:0 12px;color:var(--nx-mute)}
.nx-wsearch svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nexus-page .nx-wsearch input{flex:1;min-width:0;border:0;background:none;outline:none;font:inherit;padding:9px 0;color:var(--nx-text)}
.nx-seg{display:flex;flex-wrap:wrap;gap:4px;padding:4px 24px 12px}
.nexus-page .nx-seg a{color:var(--nx-sub);border-radius:999px;padding:4px 10px;font-size:13px;text-decoration:none;white-space:nowrap}
.nexus-page .nx-seg a:hover{background:var(--nx-soft)}
.nexus-page .nx-seg a.on{background:var(--nx-text);color:var(--nx-panel)}
.nx-seg .nx-n{margin-left:3px;opacity:.55;font-variant-numeric:tabular-nums}
.nx-rows{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding:0 12px 24px}
.nx-gh{font-size:12px;color:var(--nx-mute);padding:16px 12px 6px}
.nexus-page a.nx-wrow{display:flex;gap:12px;padding:12px;border-radius:12px;color:var(--nx-text);text-decoration:none}
.nexus-page a.nx-wrow:hover{background:var(--nx-soft)}
.nexus-page a.nx-wrow.on{background:var(--nx-accent-soft)}
.nx-sd{width:8px;height:8px;border-radius:50%;margin-top:7px;flex-shrink:0;background:var(--c)}
.nx-wm{flex:1;min-width:0}
.nx-wt{display:flex;gap:8px}
.nx-wtt{font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nx-wtm{font-size:12px;color:var(--nx-mute);white-space:nowrap}
.nx-wnx{display:block;font-size:13px;color:var(--nx-sub);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nx-wload{padding:10px 12px;text-align:center}
.nexus-page .nx-wload button{font:inherit;font-size:12.5px;color:var(--nx-sub);background:none;border:0;cursor:pointer}
.nexus-page .nx-wload button:hover{color:var(--nx-text)}
.nx-wempty{color:var(--nx-sub);padding:16px 12px}
.nx-wfoot{color:var(--nx-mute);font-size:12.5px;margin:18px 12px 0}

.nx-detail{min-width:0;background:var(--nx-bg)}
.nx-dw{max-width:860px;margin:0 auto;padding:40px 48px 80px;box-sizing:border-box}
.nx-top{display:flex;align-items:center;gap:10px;color:var(--nx-mute);font-size:13px;margin-bottom:0}
.nx-top .nx-sp{flex:1}
.nexus-page .nx-top a{color:var(--nx-sub);text-decoration:none}
.nx-top .nx-back{display:none}
.nexus-page .nx-ib{height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--nx-line);background:var(--nx-panel);color:var(--nx-sub);font:inherit;font-size:13px;cursor:pointer}
.nexus-page .nx-ib:hover{color:var(--nx-text);border-color:var(--nx-mute)}
.nexus-page .nx-dw h1.nx-wtitle{font-size:28px;font-weight:650;letter-spacing:-.02em;line-height:1.3;margin:14px 0 10px;word-break:break-word}
.nx-why{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--nx-sub);font-size:14px}
.nx-hero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:28px;align-items:center;margin-top:28px;padding:28px;background:var(--nx-panel);border:1px solid var(--nx-line);border-radius:18px}
.nx-ring{width:88px;height:88px;border-radius:50%;background:conic-gradient(var(--c) calc(var(--p) * 1%),var(--nx-soft) 0);display:grid;place-items:center}
.nx-ring-in{width:72px;height:72px;border-radius:50%;background:var(--nx-panel);display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.1}
.nx-ring-n{font-size:20px;font-weight:650}
.nx-ring-s{font-size:11px;color:var(--nx-mute);margin-top:3px}
.nx-k{font-size:12px;color:var(--nx-mute);letter-spacing:.04em}
.nx-v{font-size:15px;margin:3px 0 14px;word-break:break-word}
.nx-v:last-child{margin-bottom:0}
.nx-dw .nx-callout{margin:20px 0 0;padding:16px 20px;border-radius:14px;font-size:13.5px}
.nx-dw .nx-callout.nx-plain{color:var(--nx-sub)}
.nx-ask{margin-top:20px;padding:24px 28px;border-radius:18px;background:linear-gradient(180deg,var(--nx-amber-soft),var(--nx-panel));border:1px solid color-mix(in srgb,var(--nx-amber) 28%,var(--nx-line))}
.nx-lab{font-size:12px;font-weight:600;color:var(--nx-amber);letter-spacing:.04em;margin:0}
.nx-askt{font-size:17px;font-weight:600;margin:6px 0 4px;word-break:break-word}
.nx-askf{margin-top:16px;font-size:13.5px}
.nx-askf .nx-kv{grid-template-columns:auto minmax(0,1fr);gap:6px 18px}
.nx-acts{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:18px}
.nx-acts:empty{display:none}
.nexus-page .nx-pb{display:inline-flex;align-items:center;height:38px;padding:0 20px;border-radius:10px;border:0;background:var(--nx-text);color:var(--nx-panel);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.nx-note{font-size:12px;color:var(--nx-mute)}
.nx-sec{margin:36px 0 0}
.nx-dw .nx-sec-h{margin-bottom:12px}
.nx-hint{font-size:12.5px;color:var(--nx-mute);font-weight:400}
.nx-dw .nx-li{padding:14px 20px;gap:6px 14px}
.nx-ck{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;font-size:12px;font-weight:700;box-sizing:border-box}
.nx-ck-ok{background:var(--nx-green);color:#fff}
.nx-ck-wait{border:1.5px solid var(--nx-amber)}
.nx-ck-todo{border:1.5px dashed var(--nx-mute)}
.nx-ck-miss{background:var(--nx-gray-soft);color:var(--nx-gray)}
.nx-step-t{font-weight:500}
.nexus-page .nx-li a{color:var(--nx-text);text-decoration:none}
.nexus-page .nx-li a:hover{text-decoration:underline}
.nx-dw .nx-cm{display:block;padding:14px 20px}
.nx-cm-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.nx-cm-t{font-weight:500;flex:1 1 220px;min-width:0;word-break:break-word}
.nx-cm-m{margin-top:6px;font-size:12.5px;color:var(--nx-sub);display:flex;flex-wrap:wrap;gap:2px 14px}
.nx-cm-late{color:var(--nx-rose);font-weight:600}
.nx-cm-n{margin:6px 0 0;font-size:12.5px;color:var(--nx-sub);word-break:break-word}
.nx-cm-a{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.nx-cm-h+.nx-kv{margin-top:10px}
.nx-dw .nx-fu-plan:not(:last-child){border-bottom:6px solid color-mix(in srgb,var(--nx-sub) 22%,var(--nx-line))}
.nx-fu-s{margin-top:14px;padding-top:14px;border-top:1px solid var(--nx-line)}
.nx-fu-bad{color:var(--nx-rose)}
.nx-fu-hist{margin:0;padding:0;list-style:none}
.nx-fu-hist li{padding:10px 0;border-top:1px solid var(--nx-line);word-break:break-word}
.nx-fu-hist li:first-child{border-top:0}
.nx-fu-hist .nx-fu-hh{font-size:12.5px;color:var(--nx-sub)}
.nx-fu-hist .nx-fu-hw{font-weight:600;margin:2px 0}
.nx-fu-hist .nx-fu-hn{font-size:13px;white-space:pre-wrap}
.nx-cm-closed .nx-cm-t{color:var(--nx-mute)}
.nx-cm-hint{margin:10px 0 0;font-size:12.5px;color:var(--nx-mute)}
.nx-feed .nx-ev{grid-template-columns:92px minmax(0,1fr) auto;padding:7px 0;border-bottom:0;font-size:13.5px}
.nx-feed .nx-ev-text{color:var(--nx-sub)}
.nx-manage{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px}
@media (max-width:1200px){.nx-works{grid-template-columns:320px minmax(0,1fr);background:linear-gradient(to right,var(--nx-panel) 0 319px,var(--nx-line) 319px 320px,var(--nx-bg) 320px)}.nx-dw{padding:32px 28px 60px}}
@media (max-width:860px){
.nx-works{grid-template-columns:minmax(0,1fr);background:var(--nx-bg)}
.nx-wlist{position:static;height:auto}
.nx-rows{overflow:visible}
.nx-works.nx-auto .nx-detail{display:none}
.nx-works.nx-picked .nx-wlist{display:none}
.nx-top .nx-back{display:inline}
.nx-dw{padding:20px 16px 60px}
.nx-hero{grid-template-columns:minmax(0,1fr);gap:18px;padding:20px}
}
`;

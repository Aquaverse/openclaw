// The page skeleton (object-model design 11.5b): the rail on the left, the content on the right, the shared components
// (chip, callout, section, timeline, kv, impact list). All colours come from the --nx-* tokens. Scoped under
// .nexus-page. Pages not yet moved to the new skeleton keep their old rules (style.ts) inside .nx-content.
export const NEXUS_SHELL_CSS = `
.nexus-page{display:grid;grid-template-columns:72px minmax(0,1fr);font:14px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:inherit}
.nexus-page > nav{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 0;background:var(--nx-panel);color:var(--nx-sub);border-right:1px solid var(--nx-line)}
.nexus-page > nav a{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;box-sizing:border-box;width:60px;padding:8px 2px;border-radius:12px;color:var(--nx-sub);opacity:1;text-decoration:none;font-size:10.5px;line-height:1.25;text-align:center;word-break:break-word}
.nexus-page > nav a::before{content:attr(data-icon);font-size:19px;line-height:1.1;color:var(--nx-sub)}
.nexus-page > nav a:hover{background:var(--nx-soft)}
.nexus-page > nav a.on{background:var(--nx-accent-soft);color:var(--nx-accent);font-weight:600}
.nexus-page > nav a.on::before{color:var(--nx-accent)}
.nexus-page > nav .nx-reddot{position:absolute;top:6px;right:11px;width:8px;height:8px;border-radius:50%;background:var(--nx-rose)}
.nexus-page > nav .spacer{flex:1}
.nexus-page > nav button{font:inherit;font-size:10.5px;color:var(--nx-sub);background:none;border:1px solid var(--nx-line);border-radius:9px;padding:3px 8px;cursor:pointer;opacity:1}
.nexus-page > nav button:hover{background:var(--nx-soft)}
.nx-content{min-width:0;max-width:1040px;padding:16px 20px;box-sizing:border-box}
.nexus-page.nx-split .nx-content{max-width:none;padding:0}
.nexus-page.nx-split .nx-content > .nx-notice{margin:12px 20px 0}
.nexus-page.nx-split .nx-content > main > .muted,.nexus-page.nx-split .nx-content > main > .error{margin:16px 20px}
@media (max-width:1200px){.nexus-page{grid-template-columns:64px minmax(0,1fr)}.nexus-page > nav a{width:54px}}
@media (max-width:860px){
.nexus-page{grid-template-columns:minmax(0,1fr)}
.nexus-page > nav{flex-direction:row;flex-wrap:wrap;justify-content:flex-start;padding:6px 8px;border-right:0;border-bottom:1px solid var(--nx-line)}
.nexus-page > nav a{width:auto;min-width:54px;flex-direction:row;gap:6px;font-size:12px;padding:6px 10px}
.nexus-page > nav a::before{font-size:15px}
.nexus-page > nav .nx-reddot{top:4px;right:4px}
}
.nx-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:1px 10px;font-size:12.5px;font-weight:600;white-space:nowrap;background:var(--nx-gray-soft);color:var(--nx-gray)}
.nx-chip .nx-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}
.nx-chip.nx-accent{background:var(--nx-accent-soft);color:var(--nx-accent)}
.nx-chip.nx-blue{background:var(--nx-blue-soft);color:var(--nx-blue)}
.nx-chip.nx-green{background:var(--nx-green-soft);color:var(--nx-green)}
.nx-chip.nx-amber{background:var(--nx-amber-soft);color:var(--nx-amber)}
.nx-chip.nx-rose{background:var(--nx-rose-soft);color:var(--nx-rose)}
.nx-callout{border-radius:14px;padding:10px 14px;margin:12px 0;background:var(--nx-soft);color:var(--nx-text)}
.nx-callout.nx-amber{background:var(--nx-amber-soft)}
.nx-callout.nx-rose{background:var(--nx-rose-soft)}
.nx-callout.nx-green{background:var(--nx-green-soft)}
.nx-callout.nx-blue{background:var(--nx-blue-soft)}
.nx-callout p{margin:2px 0}
.nx-sec{margin:22px 0}
.nx-sec-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.nexus-page .nx-sec-h h2{font-size:13px;font-weight:600;margin:0;opacity:1;color:var(--nx-sub)}
.nx-box{background:var(--nx-panel);border:1px solid var(--nx-line);border-radius:16px;overflow:hidden}
.nx-li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 16px;border-bottom:1px solid var(--nx-line)}
.nx-li:last-child{border-bottom:0}
.nx-li > .nx-grow{flex:1;min-width:0;word-break:break-word}
.nx-li .nx-meta{color:var(--nx-mute);font-size:12.5px}
.nx-li.nx-muted{color:var(--nx-mute)}
.nx-kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 14px}
.nx-kv-k{color:var(--nx-mute);font-size:12.5px}
.nx-kv-v{word-break:break-word}
.nx-ev{display:grid;grid-template-columns:84px minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:8px 16px;border-bottom:1px solid var(--nx-line)}
.nx-ev:last-child{border-bottom:0}
.nx-ev-when{color:var(--nx-mute);font-size:12.5px;font-variant-numeric:tabular-nums}
.nx-ev-text{word-break:break-word}
.nx-ev-tag{color:var(--nx-sub);background:var(--nx-soft);border-radius:999px;padding:0 8px;font-size:12px}
.nx-imp{margin:8px 0}
.nx-imp-li{display:flex;gap:10px;align-items:flex-start;padding:6px 0}
.nx-imp-i{flex:0 0 20px;width:20px;height:20px;border-radius:50%;text-align:center;font-size:12px;line-height:20px;font-weight:700}
.nx-imp-li.keep .nx-imp-i{background:var(--nx-green-soft);color:var(--nx-green)}
.nx-imp-li.stop .nx-imp-i{background:var(--nx-rose-soft);color:var(--nx-rose)}
.nx-imp-li.note .nx-imp-i{background:var(--nx-amber-soft);color:var(--nx-amber)}
.nx-foot{color:var(--nx-mute);font-size:12.5px;margin-top:10px}
.nexus-page .nx-overlay{background:rgba(24,24,27,.32);backdrop-filter:blur(3px)}
.nexus-page .nx-dialog{background:var(--nx-panel,Canvas);color:var(--nx-text,CanvasText);border-radius:20px;box-shadow:var(--nx-shadow-modal,0 12px 40px rgba(0,0,0,.35))}
.nexus-page .nx-head,.nexus-page .nx-footer{background:var(--nx-panel,Canvas)}
`;

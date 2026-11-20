// The design language of the new prototype (docs/nexus/apps/nexus-ea-prototype): one page column with a head, cards and
// rows, on top of the --nx-* tokens. Only the classes the pages actually use are here; the palette stays in
// style-tokens.ts so light and dark keep working.
export const NEXUS_EA_CSS = `
.ea-page{color:var(--nx-text);max-width:1248px;margin:0 auto;padding:24px 32px 64px;box-sizing:border-box}
.ea-head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:8px 0 20px}
.ea-head-txt{flex:1;min-width:0}
.nexus-page .ea-head h1{font-size:26px;font-weight:650;letter-spacing:-.01em;margin:0;line-height:1.3}
.ea-sub{color:var(--nx-sub);font-size:13.5px;margin:4px 0 0}
.nexus-page a.ea-btn{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--nx-line);background:var(--nx-panel);color:var(--nx-text);font-size:13.5px;text-decoration:none;white-space:nowrap;box-sizing:border-box}
.nexus-page a.ea-btn:hover{border-color:var(--nx-mute)}
.nexus-page a.ea-btn.primary{background:var(--nx-text);color:var(--nx-panel);border-color:var(--nx-text)}
.ea-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:22px}
.nexus-page a.ea-kpi{position:relative;display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:12px;background:var(--nx-panel);border:1px solid var(--nx-line);text-decoration:none;color:var(--nx-text);min-width:0;box-sizing:border-box}
.nexus-page a.ea-kpi:hover{border-color:var(--nx-mute)}
.ea-kv{font-size:22px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.ea-kl{font-size:12px;color:var(--nx-sub);line-height:1.35}
.ea-kpi::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:transparent}
.ea-kpi.warn::before{background:var(--nx-amber)}
.ea-kpi.bad::before{background:var(--nx-rose)}
.ea-kpi.ok::before{background:var(--nx-green)}
.ea-kpi.bad .ea-kv{color:var(--nx-rose)}
.ea-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,320px);gap:24px;align-items:start}
.ea-col>section+section{margin-top:24px}
.ea-sec-h{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:10px;flex-wrap:wrap}
.nexus-page .ea-sec-h h2{font-size:16px;font-weight:620;margin:0;line-height:1.4}
.nexus-page .ea-sec-h h2.ea-h3{font-size:14px;font-weight:620;margin:0;line-height:1.4}
.ea-n{color:var(--nx-sub);font-size:13px;font-variant-numeric:tabular-nums}
.nexus-page a.ea-more{margin-left:auto;font-size:12.5px;color:var(--nx-sub);text-decoration:none}
.nexus-page a.ea-more:hover{color:var(--nx-text)}
.ea-empty{margin:0;padding:14px 16px;border:1px dashed var(--nx-line);border-radius:12px;color:var(--nx-sub);font-size:13px;line-height:1.6}
.nexus-page a.ea-more-line{display:block;margin-top:10px;font-size:12.5px;color:var(--nx-sub);text-decoration:none}
.nexus-page a.ea-dec{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--nx-line);border-radius:14px;background:var(--nx-panel);text-decoration:none;color:var(--nx-text)}
.nexus-page a.ea-dec+a.ea-dec{margin-top:10px}
.nexus-page a.ea-dec:hover{border-color:var(--nx-mute)}
.ea-dec-q{font-weight:600;line-height:1.45}
.ea-dec-f{font-size:12.5px;color:var(--nx-sub);line-height:1.5}
.ea-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--nx-mute)}
.ea-attns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.nexus-page a.ea-attn{display:flex;flex-direction:column;gap:5px;padding:12px 14px;border:1px solid var(--nx-line);border-left:3px solid var(--nx-line);border-radius:12px;background:var(--nx-panel);text-decoration:none;color:var(--nx-text);min-width:0;box-sizing:border-box}
.nexus-page a.ea-attn.needs{border-left-color:var(--nx-amber)}
.nexus-page a.ea-attn.blocked{border-left-color:var(--nx-rose)}
.nexus-page a.ea-attn:hover{border-color:var(--nx-mute)}
.ea-attn-top{display:flex;align-items:center;gap:8px}
.ea-tag{font-size:11.5px;padding:2px 7px;border-radius:999px;background:var(--nx-soft);color:var(--nx-sub);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.ea-tag.goal{background:var(--nx-accent-soft);color:var(--nx-accent)}
.ea-attn-time{margin-left:auto;font-size:11.5px;color:var(--nx-mute);white-space:nowrap}
.ea-attn-title{font-weight:600;line-height:1.35;word-break:break-word}
.ea-attn-line{font-size:12.5px;color:var(--nx-sub);line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ea-rows{border:1px solid var(--nx-line);border-radius:12px;background:var(--nx-panel);overflow:hidden}
.nexus-page a.ea-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:11px 14px;text-decoration:none;color:var(--nx-text)}
.nexus-page .ea-rows a.ea-row+a.ea-row{border-top:1px solid var(--nx-line)}
.nexus-page a.ea-row:hover{background:var(--nx-soft)}
.ea-row-dot{width:8px;height:8px;border-radius:50%;background:var(--nx-mute)}
.ea-row-main{min-width:0}
.ea-row-t{display:block;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-row-s{display:block;font-size:12px;color:var(--nx-sub)}
.ea-row-time{font-size:12px;color:var(--nx-mute);white-space:nowrap}
.ea-card{border:1px solid var(--nx-line);border-radius:12px;background:var(--nx-panel)}
.ea-pad{padding:14px 16px}
.ea-aside>section+section{margin-top:16px}
.nexus-page a.ea-line{display:flex;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--nx-line);text-decoration:none;color:var(--nx-text);min-width:0}
.nexus-page .ea-card a.ea-line:first-of-type{border-top:0}
.nexus-page a.ea-line:hover .ea-line-t{text-decoration:underline}
.ea-line-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-line-n{font-size:12px;color:var(--nx-sub);white-space:nowrap}

/* The prototype switches to three KPI columns below 1200px. The host rail consumes
   part of the viewport, so this keeps the common 1168px desktop window at 3x2. */
@media (max-width:1199px){
  .ea-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width:1080px){
  .ea-grid{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:720px){
  .ea-page{padding:16px 16px 48px}
  .ea-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ea-attns{grid-template-columns:minmax(0,1fr)}
}
/* ---------------------------------------------------------------- workbench & collaboration, one column */
/* The workbench and Collaboration are single columns at every width (the prototype's S02/S03 and S04/S05): the list is the
   page, and one Work or one person opens as a page of its own. The split grid in style-work.ts is scoped to Goals and
   Library, so nothing here has to undo it — these rules only restyle the list as a wide page. */
.nx-works.nx-work .nx-wlist,.nx-works.nx-people .nx-wlist{display:block;position:static;height:auto;min-height:0;background:var(--nx-bg);max-width:none;margin:0;padding:32px 40px 72px;box-sizing:border-box}
.nx-works.nx-work.nx-auto .nx-detail,.nx-works.nx-people.nx-auto .nx-detail{display:none}
.nx-works.nx-work.nx-picked .nx-wlist,.nx-works.nx-people.nx-picked .nx-wlist{display:none}
.nx-works.nx-work .nx-lh,.nx-works.nx-people .nx-lh{padding:0 0 14px}
.nexus-page .nx-works.nx-work .nx-wlist h1,.nexus-page .nx-works.nx-people .nx-wlist h1{font-size:26px;font-weight:650;letter-spacing:-.01em;line-height:1.3}
.nx-works.nx-work .nx-hello,.nx-works.nx-people .nx-hello{font-size:13.5px;margin-top:4px}
.nx-works.nx-work .nx-seg,.nx-works.nx-people .nx-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;background:var(--nx-soft);border-radius:10px;margin:0 0 16px}
.nexus-page .nx-works.nx-work .nx-seg a,.nexus-page .nx-works.nx-people .nx-seg a{border-radius:8px;padding:5px 10px;font-size:13px;color:var(--nx-sub)}
.nexus-page .nx-works.nx-work .nx-seg a:hover,.nexus-page .nx-works.nx-people .nx-seg a:hover{background:transparent;color:var(--nx-text)}
.nexus-page .nx-works.nx-work .nx-seg a.on,.nexus-page .nx-works.nx-people .nx-seg a.on{background:var(--nx-panel);color:var(--nx-text);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.nx-works.nx-work .nx-rows,.nx-works.nx-people .nx-rows{flex:none;overflow:visible;padding:0;border:1px solid var(--nx-line);border-radius:12px;background:var(--nx-panel)}
.nx-works.nx-work .nx-gh,.nx-works.nx-people .nx-gh{padding:10px 16px 6px;background:var(--nx-panel);font-size:12px;letter-spacing:.02em}
.nexus-page .nx-works.nx-work a.nx-wrow,.nexus-page .nx-works.nx-people a.nx-wrow{align-items:flex-start;padding:12px 16px;border-radius:0;gap:14px}
.nexus-page .nx-works.nx-work .nx-rows a.nx-wrow+a.nx-wrow,.nexus-page .nx-works.nx-people .nx-rows a.nx-wrow+a.nx-wrow{border-top:1px solid var(--nx-line)}
.nexus-page .nx-works.nx-work a.nx-wrow.on,.nexus-page .nx-works.nx-people a.nx-wrow.on{background:var(--nx-accent-soft)}
.nx-works.nx-work .nx-wtt,.nx-works.nx-people .nx-wtt{font-weight:600;font-size:14px}
/* A wide row has room for the whole line about the item; the single-line ellipsis was only ever right for a 380px column. */
.nx-works.nx-work .nx-wnx,.nx-works.nx-people .nx-wnx{font-size:12.5px;margin-top:3px;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.nexus-page .nx-works.nx-work a.nx-wrow:hover,.nexus-page .nx-works.nx-people a.nx-wrow:hover{background:var(--nx-soft)}
.nx-works.nx-work .nx-wfoot,.nx-works.nx-people .nx-wfoot{margin:12px 0 0;padding:0 2px}
.nx-works.nx-work .nx-wempty,.nx-works.nx-people .nx-wempty{padding:32px 16px;text-align:center;border:1px dashed var(--nx-line);border-radius:12px;background:var(--nx-panel)}
/* The search box the page moves into the header slot. */
.nexus-page .nx-works.nx-work .nx-wsearch,.nexus-page .nx-works.nx-people .nx-wsearch{background:var(--nx-panel);border:1px solid var(--nx-line);border-radius:10px;max-width:420px;margin-top:14px}
/* One Work, one person: a page of its own, with the way back at the top. */
.nexus-page .nx-works.nx-work .nx-dw,.nexus-page .nx-works.nx-people .nx-dw{max-width:1000px;padding:28px 32px 80px}
.nexus-page .nx-works.nx-work .nx-top,.nexus-page .nx-works.nx-people .nx-top{margin-bottom:8px}
.nexus-page .nx-works.nx-work.nx-picked .nx-top .nx-back,.nexus-page .nx-works.nx-people.nx-picked .nx-top .nx-back{display:inline-flex}
@media (max-width:720px){
  .nx-works.nx-work .nx-wlist,.nx-works.nx-people .nx-wlist{padding:16px 16px 48px}
  .nexus-page .nx-works.nx-work .nx-dw,.nexus-page .nx-works.nx-people .nx-dw{padding:20px 16px 64px}
}
`;

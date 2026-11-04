// The People page reuses the Work page's two-pane layout (style-work.ts); these rules only add what is its own: the title row
// with its add button, the "to confirm" rows with a button, and the three big counts of a person.
export const NEXUS_PEOPLE_CSS = `
.nx-lhr{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nx-people .nx-prow{align-items:flex-start}
.nx-people .nx-prow .nx-btn{align-self:center;flex:none}
.nx-people .nx-pst{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;text-align:center}
.nx-pn{display:flex;flex-direction:column;gap:4px}
.nx-pnn{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}
.nx-pnl{font-size:12px;color:var(--nx-mute)}
.nx-pn-late .nx-pnn{color:var(--nx-rose)}
.nx-people .nx-ptabs{padding:28px 0 0}
.nx-people .nx-box>.nx-cm-hint{margin:0;padding:10px 20px 14px}
.nexus-page .nx-pick{flex:1;min-width:0}
.nexus-page .nx-pick-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
.nexus-page .nx-pick-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--nx-line);border-radius:999px;padding:2px 6px 2px 12px;background:var(--nx-soft)}
.nexus-page .nx-pick-chip button{border:0;background:none;cursor:pointer;color:var(--nx-mute);font:inherit;padding:0 4px}
.nexus-page .nx-pick-list{border:1px solid var(--nx-line);border-radius:8px;background:var(--nx-panel);max-height:190px;overflow:auto;margin-top:4px}
.nexus-page .nx-pick-item{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;border:0;background:none;font:inherit;color:inherit;padding:7px 12px;cursor:pointer}
.nexus-page .nx-pick-item:hover{background:var(--nx-soft)}
.nexus-page .nx-pick-rel{color:var(--nx-mute);font-size:12px}
.nexus-page .nx-pick-list .muted{margin:0;padding:7px 12px}
.nx-people .nx-callout p{margin:0 0 8px}
.nx-people .nx-callout p:last-child{margin-bottom:0}
@media (max-width:860px){.nx-people .nx-pst{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}}
`;

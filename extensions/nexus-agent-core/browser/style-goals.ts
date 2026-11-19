// The Goals destination of the host's left rail: the pieces the shared list/detail skeleton (style-work.ts) does not
// already provide — the category tile, the meta line under a row, the small stat block and the new-goal footer. Colours
// come from the --nx-* tokens and the per-tone pairs (--c / --cs) the Work page defines.

/** `.nx-p45 > i` reads the width off the class, so the renderer only has to print a number it already rounded. */
const PCT_CLASSES = Array.from(
  { length: 21 },
  (_, step) => `.nx-p${step * 5}{--p:${step * 5}}`,
).join("");

export const NEXUS_GOALS_CSS = `
.nx-gtile{flex:0 0 36px;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-size:14px;font-weight:600;background:var(--cs);color:var(--c);box-sizing:border-box}
.nx-gtile.lg{flex:0 0 46px;width:46px;height:46px;border-radius:13px;font-size:19px}
.nx-gmeta{display:block;font-size:12px;color:var(--nx-mute);margin-top:3px}
.nexus-page a.nx-wrow.nx-gchild{padding-left:44px}
.nexus-page a.nx-wrow.nx-gchild .nx-gtile{flex:0 0 26px;width:26px;height:26px;border-radius:8px;font-size:11px}
.nexus-page a.nx-wrow.nx-gpending{background:var(--nx-amber-soft);align-items:center}
.nx-gpending .nx-ib{margin-left:auto;flex:0 0 auto}
.nx-gtitle{display:flex;align-items:center;gap:14px;margin:16px 0 0}
.nx-gtitle-m{min-width:0}
.nx-ghero{grid-template-columns:minmax(0,1fr) auto;align-items:start}
.nx-gstats{display:flex;gap:26px}
.nx-gstat-n{display:block;font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}
.nx-gstat-l{display:block;font-size:12px;color:var(--nx-mute);margin-top:2px}
.nx-gfoot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 24px 12px;margin-bottom:4px;border-bottom:1px solid var(--nx-line)}
.nx-gfoot-t{flex:1 0 100%;font-size:13px;font-weight:600;color:var(--nx-text);margin-bottom:2px}
.nexus-page .nx-gcat{font:inherit;font-size:13px;color:var(--nx-text);background:var(--nx-soft);border:1px solid var(--nx-line);border-radius:999px;padding:4px 12px;cursor:pointer}
.nexus-page .nx-gcat:hover{background:var(--nx-line)}
.nexus-page a.nx-gsub{color:var(--nx-text);text-decoration:none}
.nexus-page a.nx-gsub:hover{background:var(--nx-soft)}
.nx-gmetric{margin-left:10px;color:var(--nx-sub);font-variant-numeric:tabular-nums}
.nx-gbar{display:block;height:5px;border-radius:3px;background:var(--nx-soft);margin-top:5px;overflow:hidden}
.nx-gbar i{display:block;height:100%;background:var(--nx-green);width:calc(var(--p,0) * 1%)}
.nx-gretracted .nx-ev-text{text-decoration:line-through;opacity:.6}
.nx-gempty{display:grid;place-items:center;min-height:40vh}
.nx-dw .nx-muted{color:var(--nx-mute)}
${PCT_CLASSES}
`;

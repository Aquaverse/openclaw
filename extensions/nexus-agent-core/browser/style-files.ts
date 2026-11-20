// The Library destination of the host's left rail: the type tile of a file row, the head of the list (title plus the write
// buttons) and the filter row that the page moves into the list. Everything else (list, rows, detail, hero, kv) comes from
// the shared skeleton in style-work.ts.
export const NEXUS_FILES_CSS = `
.nx-ftile{flex:0 0 46px;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:10.5px;font-weight:700;letter-spacing:.02em;background:var(--cs);color:var(--c);box-sizing:border-box}
.nx-ftile.lg{flex:0 0 56px;width:56px;height:56px;border-radius:14px;font-size:12px}
/* The list head: the title never wraps, and the buttons either fit beside it or move to their own line — they never squeeze
   their own labels into a second line. */
.nx-lh-head{display:flex;align-items:center;justify-content:space-between;gap:10px 12px;flex-wrap:wrap}
.nexus-page .nx-lh-head h1{flex:none;white-space:nowrap;margin:0}
.nx-lh-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.nexus-page .nx-lh-actions .nx-ib{height:28px;padding:0 8px;font-size:12px;white-space:nowrap;flex:none}
/* The filter form: two columns of control pairs instead of one long wrapping line, so a 380px list stays readable. */
.nexus-page .nx-filebar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px;align-items:center;margin:0}
.nexus-page .nx-filebar .f-name{grid-column:1/-1}
.nexus-page .nx-filebar label{display:flex;gap:6px;align-items:center;min-width:0}
.nexus-page .nx-filebar input,.nexus-page .nx-filebar select{flex:1;min-width:0;max-width:100%;height:30px;box-sizing:border-box}
.nexus-page .nx-filebar .f-name input{width:auto}
.nexus-page .nx-filebar .nx-btn{height:30px;padding:0 12px;white-space:nowrap}
`;

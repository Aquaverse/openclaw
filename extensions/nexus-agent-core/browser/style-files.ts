// The Library destination of the host's left rail: the type tile of a file row and the upload row of the list header.
// Everything else (list, rows, detail, hero, kv) comes from the shared skeleton in style-work.ts.
export const NEXUS_FILES_CSS = `
.nx-ftile{flex:0 0 46px;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:10.5px;font-weight:700;letter-spacing:.02em;background:var(--cs);color:var(--c);box-sizing:border-box}
.nx-ftile.lg{flex:0 0 56px;width:56px;height:56px;border-radius:14px;font-size:12px}
.nx-lh-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.nx-lh-actions{display:flex;gap:6px}
.nexus-page .nx-lh-actions .nx-ib{height:30px;padding:0 12px;font-size:12.5px}
`;

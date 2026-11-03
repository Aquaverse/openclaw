// Colour tokens of the new page skeleton (object-model design 11.5b). Light is the default; the host writes its resolved
// colour mode on the root element (`data-theme-mode`), and only "dark" changes the values. Scoped under .nexus-page so
// nothing leaks into the host.
export const NEXUS_TOKENS_CSS = `
.nexus-page{
--nx-bg:#f7f7f8;--nx-panel:#ffffff;--nx-line:#ececef;--nx-soft:#f3f3f5;
--nx-text:#18181b;--nx-sub:#63636e;--nx-mute:#a1a1aa;
--nx-accent:#5b5bd6;--nx-accent-soft:#f0f0fd;
--nx-blue:#3e63dd;--nx-blue-soft:#edf2fe;
--nx-green:#30a46c;--nx-green-soft:#e9f7ef;
--nx-amber:#d97706;--nx-amber-soft:#fef6e7;
--nx-rose:#e5484d;--nx-rose-soft:#fdeeee;
--nx-gray:#8b8d98;--nx-gray-soft:#f1f1f3;
--nx-shadow-menu:0 12px 32px rgba(0,0,0,.1);--nx-shadow-modal:0 24px 64px rgba(0,0,0,.18);
}
:root[data-theme-mode="dark"] .nexus-page{
--nx-bg:#111113;--nx-panel:#1a1a1d;--nx-line:#2a2a2f;--nx-soft:#222226;
--nx-text:#ececef;--nx-sub:#a1a1ab;--nx-mute:#6f6f7a;
--nx-accent:#8b8bf0;--nx-accent-soft:color-mix(in srgb,#8b8bf0 14%,var(--nx-panel));
--nx-blue:#7c9bf5;--nx-blue-soft:color-mix(in srgb,#7c9bf5 14%,var(--nx-panel));
--nx-green:#4cc38a;--nx-green-soft:color-mix(in srgb,#4cc38a 14%,var(--nx-panel));
--nx-amber:#f0a53a;--nx-amber-soft:color-mix(in srgb,#f0a53a 14%,var(--nx-panel));
--nx-rose:#f07076;--nx-rose-soft:color-mix(in srgb,#f07076 14%,var(--nx-panel));
--nx-gray:#a3a5b0;--nx-gray-soft:color-mix(in srgb,#a3a5b0 14%,var(--nx-panel));
--nx-shadow-menu:0 12px 32px rgba(0,0,0,.4);--nx-shadow-modal:0 24px 64px rgba(0,0,0,.55);
}
`;

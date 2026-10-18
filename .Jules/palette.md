## 2025-03-09 - WebPlayer accessibility issues
**Learning:** React WebPlayer components often have heavily custom controls but lack semantic HTML accessibility like `aria-label` attributes on icon-only buttons.
**Action:** Always verify icon-only buttons in interactive player components include `aria-label` or `title` with `aria-label` for screen readers.

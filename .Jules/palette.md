## 2026-10-10 - Added aria-labels to icon-only buttons
**Learning:** Found several icon-only buttons in the application missing accessibility labels, rendering them silent for screen reader users. Added `aria-label`s matching their title attributes or function to ensure usability for assistive technology. Note: when setting dynamic `aria-label`s in JSX, ensure singular/plural matches the intended context (e.g., bulk actions).
**Action:** When creating icon buttons in React, always enforce the inclusion of `aria-label` or accessible text inside to prevent silent elements.

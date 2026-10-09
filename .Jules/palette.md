## 2025-05-18 - Added ARIA labels to buttons without text content
**Learning:** React buttons that only contain icons and lack text content, like the "Close player", "Play", "Pause", "Picture in Picture", etc., are not screen reader accessible if they don't have an `aria-label`. We should add `aria-label` to these components.
**Action:** Adding `aria-label` to these components makes them more accessible, and I should apply this fix consistently across `src/components/WebPlayer.tsx` and anywhere else icon buttons are used.

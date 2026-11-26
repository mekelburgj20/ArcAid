/**
 * G23 - the props for the panel a `RailTabs` row controls: spread them on the
 * caller's panel element. Kept out of `Tabs.tsx` for react-refresh (a component
 * file exports only components).
 */
export function tabPanelProps(idPrefix: string, activeId: string) {
    return {
        role: 'tabpanel' as const,
        id: `${idPrefix}-panel`,
        'aria-labelledby': `${idPrefix}-tab-${activeId}`,
        tabIndex: 0,
    };
}

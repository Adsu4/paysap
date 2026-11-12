# PaySap design direction

## Agreed with the user

Preserve the original visual styling and the functional, payment, privacy and accessibility improvements. The user preferred the original character and did not want a generic minimalist dashboard redesign. The subsequent approved pass prioritizes less scrolling, owner-selected coordinated palettes, simpler orders, and explicit inventory permissions.

Keep the floating white desktop shell, translucent pill navigation, soft shadows, rounded layered cards, tinted accents and bold type. Lavender is the default; ocean, forest, rose, warm sand and slate are owner-selected alternatives. Primary actions follow the selected palette; payment, review and error status colours retain their meanings.

## Width evidence

- Original seller maximum: 1280px; previous redesign: 1440px. Current restoration leaves the 1440px maximum pending layout discussion.
- Original builder/preview structure: 7:5 at large breakpoints. Both versions retain that ratio.
- Checkout maximum: restored to 576px with a combined merchant/item/total header and compact delivery fields.
- Original auth maximum: 896px with a 5:7 split; that structure was largely retained.
- The original seller workspace was not intrinsically too narrow. Nested padding, several controls serving the same product-selection task, tiny auxiliary text and breakpoint crowding reduced usable space.
- A focused checkout width and a roomy orders table serve different needs; there should not be one universal width.

## Keep and refine

| Element | Proposed treatment | Reason |
|---|---|---|
| Lavender canvas and floating white shell | Keep | Recognizable visual identity and separation from the page background. |
| Pill navigation, rounded cards and soft depth | Keep, with a small consistent radius/shadow scale | Their presence was not the underlying usability problem. |
| Indigo, emerald, amber and red | Keep semantic roles | App action, WhatsApp/payment action, review and error should be recognizable. |
| Compact bold type and Plus Jakarta Sans | Keep | Preserve the original voice while making important text readable. |
| Dark cockpit/auth panels | Keep selectively | Add contrast and character without making every area compete. |
| Seller form plus message preview | Keep the desktop split; reconsider empty-state and mobile presentation | Preview supports WhatsApp selling, but an empty preview need not dominate a phone screen. |
| Live journey/timeline | Keep actual events; simplify repeated labels and animation | It is useful when it reflects observed behavior rather than assumptions. |
| Dense desktop workspace | Refine | Compact can be efficient; tiny controls and overflowing breakpoints are not required for density. |
| Mobile role/account cue | Keep compact role text; remove duplicate right-side logo | Shared-device staff can identify the active role without repeating the store image. |
| Large introductory blocks | Shortened on checkout and mobile home | The form and primary action appear sooner without discarding hierarchy. |
| Generic flat, square dashboard treatment | Remove | It was a stylistic departure the user did not prefer. |
| Unsupported verified/reserved/sent claims | Keep removed | The badge styling may remain, but its wording must be supported by real state. |
| Duplicate SKU/description/catalog controls | Keep consolidated | Reduces effort without requiring a different aesthetic. |
| Repeated pulses, shimmer and confetti | Use selectively with reduced-motion/mute behavior | One useful signal should not compete with several decorative signals. |

## Current usability decisions

- Checkout: one delivery form at ordinary phone widths; two short delivery steps below 360px. Keep inputs at 16px and actions at least 44px high. Optional landmark and delivery review expand on demand.
- Put mobile UPI payment first. Show the QR as the desktop payment method and a mobile option for using another phone. PaySap attribution appears only in a muted footer on checkout.
- Orders: six desktop columns; compact mobile cards; expandable address and tracking details; counted filters; search; eight orders per page. Reported payment stays distinct from confirmed receipt.
- Colours: keyboard-accessible preset previews, cancel preview, and a separate Save colour action that does not submit other unfinished profile fields. Existing checkout links use the merchant's latest saved palette.
- Inventory: owners and staff with an explicit `stockAccess: true` grant may edit. All other staff can still choose catalogue products for orders. The server independently protects every mutation, including saving a custom item into the catalogue.
- Money: retain exact two-decimal prices and integer-paise validation internally. No random or extra paise are added; the interface uses ordinary rupee amounts.

## Further product decisions

1. Seller density: original compact cockpit versus a more spacious workspace; the operational home can also be compact.
2. Home priority: new sales first, tasks first, or role-specific entry points.
3. Checkout: validate completion with real customers and real mobile keyboards before further reducing labels or touch targets.
4. Width by task: approximately 1280px for normal seller work, optional wider order tables, and a focused checkout.
5. Mobile sticky action: keep reachable while preventing keyboard, validation and content obstruction.

## Verification

The current isolated test gate has 30 tests, including theme validation/persistence and inventory grant/revocation. The checkout delivery form and action fit a 390 × 844 viewport without scrolling; at 320 × 568, each delivery substep keeps its action visible. Desktop and mobile orders, theme saving and checkout inheritance are checked using synthetic data.

Current screenshots with synthetic data are in artifacts/usability-update/. Earlier styling-restoration screenshots remain in artifacts/design-restoration/. Merchant runtime data was untouched.

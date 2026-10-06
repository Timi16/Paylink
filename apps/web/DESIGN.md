# PayLink web: design system

Direction E, "bank-grade": calm, exact, trustworthy. Source of the design: the PayLink canvas
(page "PayLink · E"). Tokens live in `app/globals.css`; this file is the summary.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `--teal` | `#0F766E` | Primary actions, links, the mark |
| `--teal-hover` | `#0B5A54` | Hover |
| `--teal-deep` | `#0F5D56` | Text on teal tint |
| `--teal-tint` | `#E6F4F1` | Good-status fills, active nav |
| `--ink` | `#0F172A` | Text, dark buttons |
| `--slate` | `#475569` | Secondary text |
| `--canvas` | `#F4F6F8` | Page background |
| `--surface` | `#FFFFFF` | Cards |
| `--border` | `#E2E8F0` | Card and control borders |
| `--border-soft` | `#EEF2F6` | Row dividers |
| `--attention-*` | `#FFFBEB` / `#8A4B08` / `#F3D38B` | Needs-you, testnet tag |
| `--warn-bg` | `#FEF3C7` | Underpaid, refund owed |
| `--danger-*` | `#FEE2E2` / `#991B1B` | Unmatched, wrong asset |
| `--error` | `#B91C1C` | Field errors |
| `--night` | `#0B1220` | Auth hero, landing dark sections |

Light only. Status is never colour alone: every pill has an icon and a word.

## Type

- **Plus Jakarta Sans** 400–800 for everything. Page title 28/800/-0.02em; card title 17/700; body 14; small 12–13.
- **IBM Plex Mono** for memos, amounts in tables, addresses and hashes.
- Amounts use tabular figures. Amounts are decimal strings; never parse them into floats.

## Shape and spacing

- Radius: cards 14, auth cards 18, buttons and inputs 10, large buttons 12, pills 6, nav items 8.
- Controls are 46 px tall (50 px for the one main action on a form); small buttons 36.
- Page padding 32/40, card padding 18/20, gaps 12/16/24.

## Components (classes in `globals.css`)

`.btn` + `.btn-primary | .btn-secondary | .btn-dark | .btn-danger | .btn-link`, sizes `.btn-lg | .btn-sm | .btn-block`;
`.field`, `.label`, `.input`, `.select`, `.textarea`, `.hint`, `.field-error`; `.alert`, `.notice`, `.success`;
`.card`, `.card-pad`; `.pill` + `.pill-neutral | -good | -warn | -muted | -danger`; `.table` in `.table-wrap`;
`.seg` (segmented control, buttons with `aria-pressed`); `.page-head`, `.h1`, `.h2`, `.sub`; `.empty`; `.skeleton`.

React: `Logo`, `LogoMark`, `Icon`, `Pill`, `RequestStatusPill`, `OutcomePill`, `CopyButton`, `PasswordInput`,
`Dialog`, `Toast` (`useToast`), `AppShell`.

## Voice

Plain and specific. Say what happened and what to do next: "20.00 USDC is still due", "Send it back
from your wallet". No jargon the merchant doesn't need (say "applied", not "COUNTED"). PayLink never
moves money, so never imply it does: refunds are "send it back from your wallet, then mark it here".

## Rules

- Real `<button>`, `<a>`, `<label for>`; dialogs trap focus and close on Escape.
- Every list has loading, empty and error states.
- The permanent "Stellar Testnet · no real money" marker stays on the checkout and in the app shell.

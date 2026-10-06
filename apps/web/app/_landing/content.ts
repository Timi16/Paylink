/** Copy for the landing page, as written in the design. */

export const STEPS_COPY = [
  {
    title: "Create a request",
    body: "Set the amount and how long the link stays open. PayLink gives it a unique memo so the payment can be matched.",
  },
  {
    title: "Share one link",
    body: "Send it on WhatsApp or print the QR. Customers pay from Freighter in one tap, or from any Stellar wallet.",
  },
  {
    title: "Watch it flip to Paid",
    body: "The moment the ledger closes, the checkout and your dashboard both update, with the transaction hash as proof.",
  },
] as const;

export const FEATURES = [
  {
    icon: "M9 12l2 2 4-4M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z",
    title: "Exact matching",
    body: "Every payment is checked for wallet, asset, issuer, amount and memo before it counts toward a request.",
  },
  {
    icon: "M4 18h16M7 14V9M12 14V6M17 14v-3",
    title: "Partial payments add up",
    body: "Customers can pay in parts. PayLink totals them and shows exactly what's still due until the link expires.",
  },
  {
    icon: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM8 8l8 8",
    title: "Counterfeit USDC rejected",
    body: "A token called USDC from the wrong issuer never counts. Only Circle's USDC, or the asset you chose, marks a request paid.",
  },
  {
    icon: "M4 13h4l2 3h4l2-3h4M4 13l2-7h12l2 7v6H4z",
    title: "Unmatched inbox",
    body: "Forgot the memo? The payment waits in your inbox for you to assign it to the right order. Nothing gets lost.",
  },
  {
    icon: "M13 3L5 14h6l-1 7 8-11h-6z",
    title: "Live checkout",
    body: "The checkout updates itself when the payment lands. No refreshing, no \"did it go through?\"",
  },
  {
    icon: "M20 16H5l3 3M4 8h15l-3-3",
    title: "Refunds flagged",
    body: "Overpaid, late or wrong-asset payments are flagged with the sender's address, so you can send them back fast.",
  },
] as const;

export const DASH_POINTS = [
  { title: "Needs-attention first", body: "Unmatched payments and refunds owed sit at the top, not buried in a report." },
  { title: "Every status, explained", body: "Paid, underpaid, overpaid, late or expired, each with the reason and the next step." },
  { title: "Proof on every payment", body: "Each payment links to its transaction on Stellar Expert. No arguments about what arrived." },
] as const;

/** Facts about the Stellar network and about how PayLink works; not usage figures. */
export const NETWORK_FACTS = [
  { figure: "~5 s", body: "for a Stellar ledger to close and your payment to be final" },
  { figure: "0.00001", body: "XLM base network fee per operation, paid by the sender" },
  { figure: "0", body: "of your funds ever held by PayLink. Payments go wallet to wallet." },
] as const;

export const FAQS = [
  {
    q: "Does PayLink ever hold my money?",
    a: "No. Customers pay straight into your own Stellar wallet. PayLink only watches the network and tells you when the right payment arrives.",
  },
  {
    q: "What if a customer forgets the memo?",
    a: "The payment still reaches your wallet. PayLink puts it in your Unmatched inbox so you can assign it to the right order in two clicks, or refund it.",
  },
  {
    q: "Which wallets can customers pay from?",
    a: "Any Stellar wallet. Freighter users pay in one tap, the QR code works with wallets that support Stellar payment links, and anyone can copy the details and pay by hand.",
  },
  {
    q: "What happens if someone pays the wrong amount?",
    a: "Short payments add up until the link expires, and you see exactly what is still due. Overpayments, late payments and the wrong asset are flagged so you can refund the sender.",
  },
  {
    q: "Is this real money?",
    a: "Not yet. PayLink currently runs on Stellar Testnet, where everything uses free test tokens. Nothing you do here moves real funds.",
  },
] as const;

/** Decorative QR-like pattern for the "Share one link" illustration (not a scannable code). */
export const QR_DOTS =
  "M9 0h1v1h-1zM11 0h2v1h-2zM14 1h1v1h-1zM9 3h2v1h-2zM13 4h1v1h-1zM10 6h2v1h-2zM0 9h1v1h-1zM3 9h2v1h-2zM8 9h1v1h-1zM12 9h1v1h-1zM16 9h1v1h-1zM20 9h1v1h-1zM23 9h1v1h-1zM1 11h1v1h-1zM5 11h1v1h-1zM9 11h2v1h-2zM14 11h1v1h-1zM18 11h1v1h-1zM22 11h1v1h-1zM0 13h1v1h-1zM3 13h1v1h-1zM7 13h1v1h-1zM11 13h1v1h-1zM15 13h1v1h-1zM19 13h2v1h-2zM24 13h1v1h-1zM2 15h1v1h-1zM6 15h1v1h-1zM9 15h1v1h-1zM13 15h1v1h-1zM17 15h1v1h-1zM21 15h1v1h-1zM10 18h1v1h-1zM13 18h1v1h-1zM16 18h1v1h-1zM20 18h1v1h-1zM23 18h1v1h-1zM9 20h1v1h-1zM12 20h1v1h-1zM15 20h1v1h-1zM19 20h1v1h-1zM22 20h1v1h-1zM11 22h1v1h-1zM14 22h1v1h-1zM18 22h1v1h-1zM21 22h1v1h-1zM24 22h1v1h-1zM10 24h1v1h-1zM13 24h1v1h-1zM17 24h1v1h-1zM20 24h1v1h-1z";

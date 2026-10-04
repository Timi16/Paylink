// string <-> bigint stroops. The implementation lives in @paylink/shared so the web app
// formats amounts exactly the same way.
export {
  parseAmount,
  formatStroops,
  STROOPS_PER_UNIT,
  MAX_STROOPS,
  AMOUNT_REGEX,
} from "@paylink/shared";
